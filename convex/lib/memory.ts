import { Infer, v } from 'convex/values';
import { api, internal } from '../_generated/api.js';
import { Doc, Id } from '../_generated/dataModel.js';
import {
  ActionCtx,
  DatabaseReader,
  internalAction,
  internalMutation,
  internalQuery,
} from '../_generated/server.js';
import { asyncMap } from './utils.js';
import { EntryOfType, Memories, MemoryOfType } from '../types.js';
import { chatGPTCompletion, fetchEmbeddingBatch } from './openai.js';
import { clientMessageMapper } from '../chat.js';
import { pineconeAvailable, queryVectors, upsertVectors } from './pinecone.js';
import { chatHistoryFromMessages } from '../conversation.js';

const { embeddingId: _, ...MemoryWithoutEmbeddingId } = Memories.fields;
const NewMemory = { ...MemoryWithoutEmbeddingId, importance: v.optional(v.number()) };
const NewMemoryWithEmbedding = { ...MemoryWithoutEmbeddingId, embedding: v.array(v.number()) };
const NewMemoryObject = v.object(NewMemory);
type NewMemory = Infer<typeof NewMemoryObject>;

export interface MemoryDB {
  search(
    playerId: Id<'players'>,
    vector: number[],
    limit?: number,
  ): Promise<{ memory: Doc<'memories'>; score: number }[]>;
  accessMemories(
    playerId: Id<'players'>,
    queryEmbedding: number[],
    count?: number,
  ): Promise<{ memory: Doc<'memories'>; overallScore: number }[]>;
  addMemories(memories: NewMemory[]): Promise<void>;
  rememberConversation(
    playerName: string,
    playerId: Id<'players'>,
    playerIdentity: string,
    conversationId: Id<'conversations'>,
    lastSpokeTs?: number,
  ): Promise<boolean>;
}

export function MemoryDB(ctx: ActionCtx): MemoryDB {
  if (!pineconeAvailable()) {
    throw new Error('Pinecone environment variables not set. See the README.');
  }
  // If Pinecone env variables are defined, use that.
  const vectorSearch = async (embedding: number[], playerId: Id<'players'>, limit: number) =>
    queryVectors('embeddings', embedding, { playerId }, limit);
  const externalEmbeddingStore = async (
    embeddings: { id: Id<'embeddings'>; values: number[]; metadata: object }[],
  ) => upsertVectors('embeddings', embeddings);

  return {
    // Finds memories but doesn't mark them as accessed.
    async search(playerId, queryEmbedding, limit = 100) {
      const results = await vectorSearch(queryEmbedding, playerId, limit);
      const embeddingIds = results.map((r) => r._id);
      const memories = await ctx.runQuery(internal.lib.memory.getMemories, {
        playerId,
        embeddingIds,
      });
      return results.map(({ score }, idx) => ({ memory: memories[idx], score }));
    },

    async accessMemories(playerId, queryEmbedding, count = 10) {
      const results = await vectorSearch(queryEmbedding, playerId, 10 * count);
      return await ctx.runMutation(internal.lib.memory.accessMemories, {
        playerId,
        candidates: results,
        count,
      });
    },

    async addMemories(memoriesWithoutEmbedding) {
      const cachedEmbeddings = await ctx.runQuery(internal.lib.memory.getEmbeddingsByText, {
        texts: memoriesWithoutEmbedding.map((memory) => memory.description),
      });
      const cacheMisses = memoriesWithoutEmbedding
        .filter((memory, idx) => !cachedEmbeddings[idx])
        .map((memory) => memory.description);
      const { embeddings: missingEmbeddings } = cacheMisses.length
        ? await fetchEmbeddingBatch(cacheMisses)
        : { embeddings: [] };
      // NB: The cache gets populated by addMemories, so no need to do it here.
      missingEmbeddings.reverse();
      // Swap the cache misses with calculated embeddings
      const embeddings = cachedEmbeddings.map((cached) => cached || missingEmbeddings.pop()!);

      const memories = await asyncMap(memoriesWithoutEmbedding, async (memory, idx) => {
        const embedding = embeddings[idx];

        if (memory.importance === undefined) {
          // TODO: make a better prompt based on the user's memories
          const { content: importanceRaw } = await chatGPTCompletion({
            messages: [
              { role: 'user', content: memory.description },
              {
                role: 'user',
                content:
                  'How important is this? Answer on a scale of 0 to 9. Respond with number only, e.g. "5"',
              },
            ],
            max_tokens: 1,
          });
          let importance = NaN;
          for (let i = 0; i < importanceRaw.length; i++) {
            const number = parseInt(importanceRaw[i]);
            if (!isNaN(number)) {
              importance = number;
              break;
            }
          }
          importance = parseFloat(importanceRaw);
          if (isNaN(importance)) {
            console.log('importance is NaN', importanceRaw);
            importance = 5;
          }
          return { ...memory, embedding, importance };
        } else {
          return { ...memory, embedding, importance: memory.importance };
        }
      });
      const embeddingIds = await ctx.runMutation(internal.lib.memory.addMemories, { memories });
      if (externalEmbeddingStore) {
        await externalEmbeddingStore(
          embeddingIds.map((id, idx) => ({
            id,
            values: embeddings[idx],
            metadata: { playerId: memories[idx].playerId },
          })),
        );
      }
    },

    async rememberConversation(playerName, playerId, playerIdentity, conversationId, lastSpokeTs) {
      const messages = await ctx.runQuery(internal.lib.memory.getRecentMessages, {
        playerId,
        conversationId,
        lastSpokeTs,
      });
      if (!messages.length) return false;
      const { content: description } = await chatGPTCompletion({
        messages: [
          {
            role: 'user',
            content: `The following are messages. You are ${playerName}, and ${playerIdentity}
            I would like you to summarize the conversation in a paragraph from your perspective. Add if you like or dislike this interaction.`,
          },
          ...chatHistoryFromMessages(messages),
          {
            role: 'user',
            content: `Summary:`,
          },
        ],
        max_tokens: 500,
      });
      await this.addMemories([
        {
          playerId,
          description,
          data: {
            type: 'conversation',
            conversationId,
          },
        },
      ]);
      return true;
    },
  };
}

export const filterMemoriesType = (
  memoryTypes: string[],
  memories: { memory: Doc<'memories'>; overallScore: number }[],
) => {
  return memories.filter((m: any) => {
    return memoryTypes.includes(m.memory.data.type);
  });
};

export const getMemories = internalQuery({
  args: { playerId: v.id('players'), embeddingIds: v.array(v.id('embeddings')) },
  handler: async (ctx, args) => {
    return await asyncMap(args.embeddingIds, (id) =>
      getMemoryByEmbeddingId(ctx.db, args.playerId, id),
    );
  },
});

export const accessMemories = internalMutation({
  args: {
    playerId: v.id('players'),
    candidates: v.array(v.object({ _id: v.id('embeddings'), score: v.number() })),
    count: v.number(),
  },
  handler: async (ctx, { playerId, candidates, count }) => {
    const ts = Date.now();
    const relatedMemories = await asyncMap(candidates, ({ _id }) =>
      getMemoryByEmbeddingId(ctx.db, playerId, _id),
    );
    // TODO: fetch <count> recent memories and <count> important memories
    // so we don't miss them in case they were a little less relevant.
    const recencyScore = await asyncMap(relatedMemories, async (memory) => {
      const access = await ctx.db
        .query('memoryAccesses')
        .withIndex('by_memoryId', (q) => q.eq('memoryId', memory._id))
        .order('desc')
        .first();
      if (!access) return 1;
      const accessTime = access ? access._creationTime : memory._creationTime;
      return 0.99 ^ Math.floor((ts - accessTime) / 1000 / 60 / 60);
    });
    const relevanceRange = makeRange(candidates.map((c) => c.score));
    const importanceRange = makeRange(relatedMemories.map((m) => m.importance));
    const recencyRange = makeRange(recencyScore);
    const memoryScores = relatedMemories.map((memory, idx) => ({
      memory,
      overallScore:
        normalize(candidates[idx].score, relevanceRange) +
        normalize(memory.importance, importanceRange) +
        normalize(recencyScore[idx], recencyRange),
    }));
    memoryScores.sort((a, b) => b.overallScore - a.overallScore);
    const accessed = memoryScores.slice(0, count);
    await Promise.all(
      accessed.map(({ memory }) => ctx.db.insert('memoryAccesses', { memoryId: memory._id })),
    );
    return accessed;
  },
});

function normalize(value: number, range: readonly [number, number]) {
  const [min, max] = range;
  return (value - min) / (max - min);
}

function makeRange(values: number[]) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return [min, max] as const;
}

// Unused, but in case they're helpful later.
// export const embedMemory = internalAction({
//   args: { memory: v.object(NewMemory) },
//   handler: async (ctx, args): Promise<Id<'memories'>> => {
//     return (await MemoryDB(ctx).addMemories([args.memory]))[0];
//   },
// });

// export const embedMemories = internalAction({
//   args: { memories: v.array(v.object(NewMemory)) },
//   handler: async (ctx, args): Promise<Id<'memories'>[]> => {
//     return await MemoryDB(ctx).addMemories(args.memories);
//   },
// });

// export const addMemory = internalMutation({
//   args: NewMemoryWithEmbedding,
//   handler: async (ctx, args): Promise<Id<'memories'>> => {
//     const { embedding, ...memory } = args;
//     const { playerId, description: text } = memory;
//     const embeddingId = await ctx.db.insert('embeddings', { playerId, embedding, text });
//     return await ctx.db.insert('memories', { ...memory, embeddingId });
//   },
// });

export const addMemories = internalMutation({
  args: { memories: v.array(v.object(NewMemoryWithEmbedding)) },
  handler: async (ctx, args): Promise<Id<'embeddings'>[]> => {
    return asyncMap(args.memories, async (memoryWithEmbedding) => {
      const { embedding, ...memory } = memoryWithEmbedding;
      const { playerId, description: text } = memory;
      const embeddingId = await ctx.db.insert('embeddings', { playerId, embedding, text });
      await ctx.db.insert('memories', { ...memory, embeddingId });
      return embeddingId;
    });
  },
});

// Technically it's redundant to retrieve them by playerId, since the embedding
// is stored associated with an playerId already.
async function getMemoryByEmbeddingId(
  db: DatabaseReader,
  playerId: Id<'players'>,
  embeddingId: Id<'embeddings'>,
) {
  const doc = await db
    .query('memories')
    .withIndex('by_playerId_embeddingId', (q) =>
      q.eq('playerId', playerId).eq('embeddingId', embeddingId),
    )
    .order('desc')
    .first();
  if (!doc) throw new Error(`No memory found for player ${playerId} and embedding ${embeddingId}`);
  return doc;
}

export async function checkEmbeddingCache(db: DatabaseReader, texts: string[]) {
  return asyncMap(texts, async (text) => {
    const existing = await db
      .query('embeddings')
      .withIndex('by_text', (q) => q.eq('text', text))
      .first();
    if (existing) return existing.embedding;
    return null;
  });
}

export const getEmbeddingsByText = internalQuery({
  args: { texts: v.array(v.string()) },
  handler: async (ctx, args) => {
    return checkEmbeddingCache(ctx.db, args.texts);
  },
});

export const getRecentMessages = internalQuery({
  args: {
    playerId: v.id('players'),
    conversationId: v.id('conversations'),
    lastSpokeTs: v.optional(v.number()),
  },
  handler: async (ctx, { playerId, conversationId, lastSpokeTs }) => {
    // Fetch the last memory, whether it was this conversation or not.
    const lastConversationMemory = (await ctx.db
      .query('memories')
      .withIndex('by_playerId_type', (q) =>
        q.eq('playerId', playerId).eq('data.type', 'conversation'),
      )
      .order('desc')
      .first()) as MemoryOfType<'conversation'> | null;

    if (lastSpokeTs && lastSpokeTs < (lastConversationMemory?._creationTime ?? 0)) {
      // We haven't spoken since a conversation memory, so probably not worth recording.
      return [];
    }

    const allMessages = (await ctx.db
      .query('journal')
      .withIndex('by_conversation', (q) => {
        const q2 = q.eq('data.conversationId', conversationId as any);
        if (lastConversationMemory?.data.conversationId === conversationId) {
          // If we have a memory of this conversation, only look at messages after.
          return q2.gt('_creationTime', lastConversationMemory._creationTime);
        }
        return q2;
      })
      .filter((q) => q.eq(q.field('data.type'), 'talking'))
      .collect()) as EntryOfType<'talking'>[];
    // Find if we have a memory of this conversation already.
    // This may be before the last conversation memory we've had.
    // Only need to check from when the first message exists.
    // Only a slight optimization over the previous one, which might scan to the
    // beginning of time.
    let lastMemoryTs: number;
    if (lastConversationMemory && lastConversationMemory.data.conversationId === conversationId) {
      lastMemoryTs = lastConversationMemory._creationTime;
    } else {
      const previousConversationMemory = await ctx.db
        .query('memories')
        .withIndex('by_playerId_type', (q) =>
          q
            .eq('playerId', playerId)
            .eq('data.type', 'conversation')
            .gt('_creationTime', allMessages[0]._creationTime),
        )
        .order('desc')
        .filter((q) => q.eq(q.field('data.conversationId'), conversationId))
        .first();
      lastMemoryTs = previousConversationMemory?._creationTime ?? 0;
    }
    return (await asyncMap(allMessages, clientMessageMapper(ctx.db))).filter(
      (m) => m.ts > lastMemoryTs && (m.from === playerId || m.to.includes(playerId)),
    );
  },
});
