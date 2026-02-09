/**
 * LONG-TERM MEMORY SERVICE - Persistent facts, preferences, and decisions.
 * Layer 2 of the two-layer memory system.
 *
 * Stores important information extracted from conversations that should
 * persist beyond the short-term conversation window.
 */
import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ModelFactoryService } from '../model/model-factory.service';
import { UsageService } from '../usage/usage.service';
import {
  LongTermMemoryEntry,
  LongTermMemoryStore,
  MemoryCategory,
  ExtractedMemory,
} from './memory.types';

@Injectable()
export class LongTermMemoryService {
  private readonly logger = new Logger(LongTermMemoryService.name);
  private readonly dataDir: string;
  private model: ChatOpenAI;

  // In-memory cache
  private cache: Map<string, LongTermMemoryStore> = new Map();

  constructor(
    @Inject(forwardRef(() => ModelFactoryService))
    private readonly modelFactory: ModelFactoryService,
    @Inject(forwardRef(() => UsageService))
    private readonly usageService: UsageService,
  ) {
    this.dataDir = path.join(process.cwd(), 'data');
    this.model = this.modelFactory.getModel('main');
  }

  /**
   * Get the long-term memory file path for a chat
   */
  private getMemoryPath(chatId: string): string {
    return path.join(this.dataDir, chatId, 'longterm-memory.json');
  }

  /**
   * Generate a unique ID for a memory entry
   */
  private generateId(): string {
    return crypto.randomBytes(8).toString('hex');
  }

  /**
   * Load long-term memory for a chat
   */
  private loadMemory(chatId: string): LongTermMemoryStore {
    if (this.cache.has(chatId)) {
      return this.cache.get(chatId)!;
    }

    const memoryPath = this.getMemoryPath(chatId);

    try {
      if (fs.existsSync(memoryPath)) {
        const content = fs.readFileSync(memoryPath, 'utf-8');
        const store: LongTermMemoryStore = JSON.parse(content);
        this.cache.set(chatId, store);
        return store;
      }
    } catch (error) {
      this.logger.error(`Failed to load long-term memory for ${chatId}: ${error}`);
    }

    // Return empty store if not found
    const emptyStore: LongTermMemoryStore = {
      chatId,
      entries: [],
      lastUpdated: new Date().toISOString(),
    };
    this.cache.set(chatId, emptyStore);
    return emptyStore;
  }

  /**
   * Save long-term memory to disk
   */
  private saveMemory(chatId: string, store: LongTermMemoryStore): void {
    try {
      const chatDir = path.join(this.dataDir, chatId);
      if (!fs.existsSync(chatDir)) {
        fs.mkdirSync(chatDir, { recursive: true });
      }

      const memoryPath = this.getMemoryPath(chatId);
      store.lastUpdated = new Date().toISOString();
      fs.writeFileSync(memoryPath, JSON.stringify(store, null, 2));

      this.cache.set(chatId, store);
    } catch (error) {
      this.logger.error(`Failed to save long-term memory for ${chatId}: ${error}`);
    }
  }

  /**
   * Get all long-term memories for a chat
   */
  getMemories(chatId: string): LongTermMemoryEntry[] {
    const store = this.loadMemory(chatId);
    return store.entries;
  }

  /**
   * Get memories by category
   */
  getMemoriesByCategory(chatId: string, category: MemoryCategory): LongTermMemoryEntry[] {
    const store = this.loadMemory(chatId);
    return store.entries.filter((e) => e.category === category);
  }

  /**
   * Add a new memory entry
   */
  addMemory(
    chatId: string,
    entry: Omit<LongTermMemoryEntry, 'id' | 'createdAt'>,
  ): LongTermMemoryEntry {
    const store = this.loadMemory(chatId);

    const newEntry: LongTermMemoryEntry = {
      ...entry,
      id: this.generateId(),
      createdAt: new Date().toISOString(),
    };

    // Check for duplicates (similar content)
    const isDuplicate = store.entries.some(
      (e) => this.isSimilarContent(e.content, newEntry.content),
    );

    if (!isDuplicate) {
      store.entries.push(newEntry);
      this.saveMemory(chatId, store);
      this.logger.log(`Added long-term memory for ${chatId}: ${newEntry.content.substring(0, 50)}...`);
    } else {
      this.logger.debug(`Skipped duplicate memory for ${chatId}`);
    }

    return newEntry;
  }

  /**
   * Delete a memory entry by ID
   */
  deleteMemory(chatId: string, memoryId: string): boolean {
    const store = this.loadMemory(chatId);
    const initialLength = store.entries.length;

    store.entries = store.entries.filter((e) => e.id !== memoryId);

    if (store.entries.length < initialLength) {
      this.saveMemory(chatId, store);
      this.logger.log(`Deleted long-term memory ${memoryId} for ${chatId}`);
      return true;
    }

    return false;
  }

  /**
   * Update a memory entry
   */
  updateMemory(
    chatId: string,
    memoryId: string,
    updates: Partial<Omit<LongTermMemoryEntry, 'id' | 'createdAt'>>,
  ): LongTermMemoryEntry | null {
    const store = this.loadMemory(chatId);
    const entry = store.entries.find((e) => e.id === memoryId);

    if (!entry) {
      return null;
    }

    Object.assign(entry, updates);
    this.saveMemory(chatId, store);
    return entry;
  }

  /**
   * Check if two content strings are similar (simple check)
   */
  private isSimilarContent(a: string, b: string): boolean {
    const normalize = (s: string) =>
      s.toLowerCase().replace(/[^\w\s]/g, '').trim();
    const normalizedA = normalize(a);
    const normalizedB = normalize(b);

    // Exact match
    if (normalizedA === normalizedB) {
      return true;
    }

    // One contains the other (at least 80%)
    if (normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA)) {
      const shorter = normalizedA.length < normalizedB.length ? normalizedA : normalizedB;
      const longer = normalizedA.length < normalizedB.length ? normalizedB : normalizedA;
      if (shorter.length / longer.length > 0.8) {
        return true;
      }
    }

    return false;
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
      // Format conversation for LLM
      const conversationText = messages
        .map((m) => {
          const roleLabel = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'Context';
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

      const content = typeof response.content === 'string' ? response.content : String(response.content);

      // Parse JSON from response
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return [];
      }

      const extracted: ExtractedMemory[] = JSON.parse(jsonMatch[0]);

      // Validate and filter
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
   * Called during compaction or before reset
   */
  async extractAndSaveMemories(
    chatId: string,
    messages: Array<{ role: string; content: string }>,
    source: 'compaction' | 'auto' = 'compaction',
  ): Promise<number> {
    const extracted = await this.extractImportantFacts(chatId, messages);

    let savedCount = 0;
    for (const memory of extracted) {
      const entry = this.addMemory(chatId, {
        content: memory.content,
        category: memory.category,
        source,
        tags: memory.tags,
      });

      // Check if it was actually added (not duplicate)
      if (entry) {
        savedCount++;
      }
    }

    if (savedCount > 0) {
      this.logger.log(`Extracted and saved ${savedCount} long-term memories for ${chatId}`);
    }

    return savedCount;
  }

  /**
   * Clear all long-term memories for a chat (for testing or reset)
   */
  clearMemories(chatId: string): void {
    const emptyStore: LongTermMemoryStore = {
      chatId,
      entries: [],
      lastUpdated: new Date().toISOString(),
    };
    this.saveMemory(chatId, emptyStore);
    this.logger.log(`Cleared long-term memory for ${chatId}`);
  }

  /**
   * Get memory statistics
   */
  getStats(chatId: string): { total: number; byCategory: Record<string, number> } {
    const store = this.loadMemory(chatId);
    const byCategory: Record<string, number> = {};

    for (const entry of store.entries) {
      byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
    }

    return {
      total: store.entries.length,
      byCategory,
    };
  }

  /**
   * Search memories by keyword
   */
  searchByKeyword(chatId: string, keyword: string): LongTermMemoryEntry[] {
    const store = this.loadMemory(chatId);
    const normalizedKeyword = keyword.toLowerCase();

    return store.entries.filter((e) => {
      const contentMatch = e.content.toLowerCase().includes(normalizedKeyword);
      const tagMatch = e.tags?.some((t) => t.toLowerCase().includes(normalizedKeyword));
      return contentMatch || tagMatch;
    });
  }
}
