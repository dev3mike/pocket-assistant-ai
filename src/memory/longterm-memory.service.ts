/**
 * LONG-TERM MEMORY SERVICE - Persistent facts, preferences, and decisions.
 * Layer 2 of the two-layer memory system.
 *
 * Uses ChromaDB for vector storage and semantic search.
 * If ChromaDB is unavailable, long-term memory features are disabled.
 */
import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import * as crypto from 'crypto';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ModelFactoryService } from '../model/model-factory.service';
import { UsageService } from '../usage/usage.service';
import { ChromaService } from '../chroma/chroma.service';
import {
  LongTermMemoryEntry,
  MemoryCategory,
  MemorySource,
  ExtractedMemory,
  MemorySearchResult,
} from './memory.types';

@Injectable()
export class LongTermMemoryService {
  private readonly logger = new Logger(LongTermMemoryService.name);
  private model: ChatOpenAI;

  constructor(
    @Inject(forwardRef(() => ModelFactoryService))
    private readonly modelFactory: ModelFactoryService,
    @Inject(forwardRef(() => UsageService))
    private readonly usageService: UsageService,
    @Inject(forwardRef(() => ChromaService))
    private readonly chromaService: ChromaService,
  ) {
    this.model = this.modelFactory.getModel('main');
  }

  /**
   * Check if long-term memory is available (ChromaDB connected)
   */
  isAvailable(): boolean {
    return this.chromaService.isReady();
  }

  /**
   * Generate a unique ID for a memory entry
   */
  private generateId(): string {
    return crypto.randomBytes(8).toString('hex');
  }

  /**
   * Get all long-term memories for a chat
   */
  async getMemories(chatId: string): Promise<LongTermMemoryEntry[]> {
    if (!this.isAvailable()) {
      return [];
    }

    const docs = await this.chromaService.getAllDocuments(chatId);
    return docs.map((doc) => {
      const extra = doc.metadata.extra;
      let metadata: Record<string, any> = {};
      if (typeof extra === 'string' && extra) {
        try {
          metadata = JSON.parse(extra);
        } catch {
          metadata = {};
        }
      } else if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
        metadata = extra as Record<string, any>;
      }
      return {
        id: doc.id,
        content: doc.content,
        category: doc.metadata.category as MemoryCategory,
        source: doc.metadata.source as MemorySource,
        createdAt: doc.metadata.createdAt,
        tags: doc.metadata.tags,
        metadata,
      };
    });
  }

  /**
   * Get memories by category
   */
  async getMemoriesByCategory(
    chatId: string,
    category: MemoryCategory,
  ): Promise<LongTermMemoryEntry[]> {
    const memories = await this.getMemories(chatId);
    return memories.filter((e) => e.category === category);
  }

  /**
   * Add a new memory entry
   */
  async addMemory(
    chatId: string,
    entry: Omit<LongTermMemoryEntry, 'id' | 'createdAt'>,
  ): Promise<LongTermMemoryEntry> {
    const newEntry: LongTermMemoryEntry = {
      ...entry,
      id: this.generateId(),
      createdAt: new Date().toISOString(),
    };

    if (!this.isAvailable()) {
      this.logger.warn('ChromaDB not available, memory not saved');
      return newEntry;
    }

    // Check for duplicates using semantic similarity
    const similar = await this.chromaService.search(chatId, newEntry.content, {
      maxResults: 1,
    });

    // Distance threshold: 0.1 means very similar (cosine distance)
    if (similar.length > 0 && similar[0].distance < 0.1) {
      this.logger.debug(`Skipped duplicate memory for ${chatId} (similar to ${similar[0].id})`);
      return newEntry;
    }

    // Chroma only allows metadata values: string, number, boolean, null, or string[]/number[]/boolean[]
    const success = await this.chromaService.addDocuments(chatId, [
      {
        id: newEntry.id,
        content: newEntry.content,
        metadata: {
          category: newEntry.category,
          source: newEntry.source,
          createdAt: newEntry.createdAt,
          tags: newEntry.tags || [],
          extra: newEntry.metadata ? JSON.stringify(newEntry.metadata) : null,
        },
      },
    ]);

    if (success) {
      this.logger.log(
        `Added long-term memory for ${chatId}: ${newEntry.content.substring(0, 50)}...`,
      );
    }

    return newEntry;
  }

  /**
   * Delete a memory entry by ID
   */
  async deleteMemory(chatId: string, memoryId: string): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    const success = await this.chromaService.deleteDocument(chatId, memoryId);
    if (success) {
      this.logger.log(`Deleted long-term memory ${memoryId} for ${chatId}`);
    }
    return success;
  }

  /**
   * Update a memory entry
   */
  async updateMemory(
    chatId: string,
    memoryId: string,
    updates: Partial<Omit<LongTermMemoryEntry, 'id' | 'createdAt'>>,
  ): Promise<LongTermMemoryEntry | null> {
    if (!this.isAvailable()) {
      return null;
    }

    const existing = await this.chromaService.getDocument(chatId, memoryId);
    if (!existing) return null;

    const existingExtra = existing.metadata.extra;
    let existingExtraObj: Record<string, any> = {};
    if (typeof existingExtra === 'string' && existingExtra) {
      try {
        existingExtraObj = JSON.parse(existingExtra);
      } catch {
        existingExtraObj = {};
      }
    } else if (existingExtra && typeof existingExtra === 'object' && !Array.isArray(existingExtra)) {
      existingExtraObj = existingExtra as Record<string, any>;
    }

    const updatedContent = updates.content || existing.content;
    const mergedExtra = { ...existingExtraObj, ...(updates.metadata ?? {}) };
    const chromaMetadata = {
      ...existing.metadata,
      ...(updates.category && { category: updates.category }),
      ...(updates.source && { source: updates.source }),
      ...(updates.tags && { tags: updates.tags }),
      extra: JSON.stringify(mergedExtra),
    };

    await this.chromaService.updateDocument(chatId, memoryId, updatedContent, chromaMetadata);

    return {
      id: memoryId,
      content: updatedContent,
      category: (chromaMetadata.category ?? existing.metadata.category) as MemoryCategory,
      source: (chromaMetadata.source ?? existing.metadata.source) as MemorySource,
      createdAt: existing.metadata.createdAt,
      tags: chromaMetadata.tags ?? existing.metadata.tags,
      metadata: mergedExtra,
    };
  }

  /**
   * Search memories using semantic similarity via ChromaDB
   */
  async searchMemories(
    chatId: string,
    query: string,
    options: { maxResults?: number; minScore?: number; category?: MemoryCategory } = {},
  ): Promise<MemorySearchResult[]> {
    if (!this.isAvailable()) {
      return [];
    }

    const { maxResults = 5, minScore = 0.3, category } = options;

    const results = await this.chromaService.search(chatId, query, {
      maxResults,
      where: category ? { category } : undefined,
    });

    return results
      .filter((r) => {
        // Convert distance to similarity score (1 - distance for cosine)
        const score = 1 - r.distance;
        return score >= minScore;
      })
      .map((r) => ({
        id: r.id,
        content: r.content,
        score: 1 - r.distance,
        source: 'long-term' as const,
        timestamp: r.metadata.createdAt,
        category: r.metadata.category as MemoryCategory,
      }));
  }

  /**
   * Extract important facts from a conversation using LLM
   */
  async extractImportantFacts(
    chatId: string,
    messages: Array<{ role: string; content: string }>,
  ): Promise<ExtractedMemory[]> {
    if (messages.length === 0) {
      return [];
    }

    try {
      const conversationText = messages
        .map((m) => {
          const roleLabel =
            m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'Context';
          return `${roleLabel}: ${m.content}`;
        })
        .join('\n\n');

      const response = await this.model.invoke([
        new SystemMessage(
          `You are analyzing a conversation to extract important long-term memories worth preserving.

CRITICAL: Be VERY conservative. Most conversations contain NOTHING worth remembering long-term.

Extract ONLY genuinely important information that the user EXPLICITLY states about themselves:
- Personal facts the user directly shares (name, location, profession, birthday)
- Explicit preferences the user states ("I prefer...", "I like...", "I always want...")
- Decisions the user explicitly makes ("I decided to...", "Let's go with...")
- Ongoing projects/goals the user describes in detail

DO NOT extract:
- Inferred interests from queries (asking BTC price ≠ "interested in crypto")
- One-time lookups or informational requests (weather, prices, news, time)
- Transactional requests that don't reveal lasting preferences
- Scheduled tasks, reminders, or cron jobs
- Runtime state or temporary values
- Casual conversation or greetings
- Anything you have to INFER rather than the user EXPLICITLY stating
- Role-play instructions ("act as...", "pretend you are...", "you are a...", "behave like a...")
- Temporary personas or characters the AI is asked to adopt
- Simulation requests or hypothetical scenarios

KEY DISTINCTION:
- "What's the BTC price?" → DO NOT save (just a query, not a stated interest)
- "I'm a crypto trader and need to track BTC daily" → SAVE (explicit statement about themselves)
- "Check the weather" → DO NOT save (transactional request)
- "I live in Gothenburg" → SAVE (explicit personal fact)

For each extracted memory, categorize it as:
- "fact" - factual information the user explicitly stated about themselves
- "preference" - preferences the user explicitly expressed (not inferred)
- "decision" - a decision the user explicitly made
- "context" - ongoing context explicitly described by the user

Respond with a JSON array of objects. If nothing important to extract (MOST CASES), return an empty array [].

Example response:
[
  {"content": "User's name is John", "category": "fact", "tags": ["identity"]},
  {"content": "User prefers TypeScript over JavaScript", "category": "preference", "tags": ["programming", "language"]}
]`,
        ),
        new HumanMessage(
          `Analyze this conversation and extract ONLY explicitly stated long-term memories:

${conversationText}

Return a JSON array of extracted memories (or [] if nothing explicitly stated - this is the expected outcome for most conversations):`,
        ),
      ]);

      if (AIMessage.isInstance(response)) {
        this.usageService.recordUsageFromResponse(chatId, response);
      }

      const content =
        typeof response.content === 'string' ? response.content : String(response.content);

      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return [];
      }

      const extracted: ExtractedMemory[] = JSON.parse(jsonMatch[0]);

      return extracted.filter(
        (e) =>
          e.content &&
          typeof e.content === 'string' &&
          e.content.trim().length > 0 &&
          ['fact', 'preference', 'decision', 'context', 'todo'].includes(e.category),
      );
    } catch (error) {
      this.logger.error(`Failed to extract important facts for ${chatId}: ${error}`);
      return [];
    }
  }

  /**
   * Extract and save important facts from a conversation
   */
  async extractAndSaveMemories(
    chatId: string,
    messages: Array<{ role: string; content: string }>,
    source: 'compaction' | 'auto' = 'compaction',
  ): Promise<number> {
    if (!this.isAvailable()) {
      this.logger.debug('ChromaDB not available, skipping memory extraction');
      return 0;
    }

    const extracted = await this.extractImportantFacts(chatId, messages);

    let savedCount = 0;
    for (const memory of extracted) {
      await this.addMemory(chatId, {
        content: memory.content,
        category: memory.category,
        source,
        tags: memory.tags,
      });
      savedCount++;
    }

    if (savedCount > 0) {
      this.logger.log(`Extracted and saved ${savedCount} long-term memories for ${chatId}`);
    }

    return savedCount;
  }

  /**
   * Clear all long-term memories for a chat
   */
  async clearMemories(chatId: string): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }

    await this.chromaService.clearCollection(chatId);
    this.logger.log(`Cleared long-term memory for ${chatId}`);
  }

  /**
   * Get memory statistics
   */
  async getStats(chatId: string): Promise<{ total: number; byCategory: Record<string, number> }> {
    if (!this.isAvailable()) {
      return { total: 0, byCategory: {} };
    }

    const memories = await this.getMemories(chatId);

    const byCategory: Record<string, number> = {};
    for (const entry of memories) {
      byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
    }

    return {
      total: memories.length,
      byCategory,
    };
  }
}
