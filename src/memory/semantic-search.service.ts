/**
 * SEMANTIC SEARCH SERVICE - Hybrid search across memory layers.
 *
 * Combines semantic (embedding-based) and keyword search to find
 * relevant memories from both short-term and long-term storage.
 */
import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { EmbeddingService } from './embedding.service';
import { LongTermMemoryService } from './longterm-memory.service';
import { MemoryMessage } from './memory.service';
import {
  EmbeddingEntry,
  EmbeddingsStore,
  MemorySearchResult,
  MemorySearchOptions,
  LongTermMemoryEntry,
} from './memory.types';

@Injectable()
export class SemanticSearchService {
  private readonly logger = new Logger(SemanticSearchService.name);
  private readonly dataDir: string;

  // Weights for hybrid search (semantic vs keyword)
  private readonly SEMANTIC_WEIGHT = 0.7;
  private readonly KEYWORD_WEIGHT = 0.3;

  // Embeddings cache per chat
  private embeddingsCache: Map<string, EmbeddingsStore> = new Map();

  constructor(
    @Inject(forwardRef(() => EmbeddingService))
    private readonly embeddingService: EmbeddingService,
    @Inject(forwardRef(() => LongTermMemoryService))
    private readonly longTermMemoryService: LongTermMemoryService,
  ) {
    this.dataDir = path.join(process.cwd(), 'data');
  }

  /**
   * Get embeddings file path for a chat
   */
  private getEmbeddingsPath(chatId: string): string {
    return path.join(this.dataDir, chatId, 'embeddings.json');
  }

  /**
   * Load embeddings from disk
   */
  private loadEmbeddings(chatId: string): EmbeddingsStore {
    if (this.embeddingsCache.has(chatId)) {
      return this.embeddingsCache.get(chatId)!;
    }

    const embeddingsPath = this.getEmbeddingsPath(chatId);

    try {
      if (fs.existsSync(embeddingsPath)) {
        const content = fs.readFileSync(embeddingsPath, 'utf-8');
        const store: EmbeddingsStore = JSON.parse(content);
        this.embeddingsCache.set(chatId, store);
        return store;
      }
    } catch (error) {
      this.logger.error(`Failed to load embeddings for ${chatId}: ${error}`);
    }

    const emptyStore: EmbeddingsStore = {
      chatId,
      entries: [],
      lastUpdated: new Date().toISOString(),
    };
    this.embeddingsCache.set(chatId, emptyStore);
    return emptyStore;
  }

  /**
   * Save embeddings to disk
   */
  private saveEmbeddings(chatId: string, store: EmbeddingsStore): void {
    try {
      const chatDir = path.join(this.dataDir, chatId);
      if (!fs.existsSync(chatDir)) {
        fs.mkdirSync(chatDir, { recursive: true });
      }

      const embeddingsPath = this.getEmbeddingsPath(chatId);
      store.lastUpdated = new Date().toISOString();
      fs.writeFileSync(embeddingsPath, JSON.stringify(store, null, 2));

      this.embeddingsCache.set(chatId, store);
    } catch (error) {
      this.logger.error(`Failed to save embeddings for ${chatId}: ${error}`);
    }
  }

  /**
   * Index short-term memory messages
   */
  async indexShortTermMemory(chatId: string, messages: MemoryMessage[]): Promise<void> {
    if (!this.embeddingService.isReady()) {
      this.logger.warn('EmbeddingService not ready, skipping indexing');
      return;
    }

    if (messages.length === 0) {
      return;
    }

    const store = this.loadEmbeddings(chatId);

    // Filter out messages that are already indexed (by hash)
    const existingHashes = new Set(store.entries.map((e) => e.textHash));
    const newMessages = messages.filter((m) => {
      const hash = this.embeddingService.getTextHash(m.content);
      return !existingHashes.has(hash);
    });

    if (newMessages.length === 0) {
      return;
    }

    try {
      // Generate embeddings for new messages
      const texts = newMessages.map((m) => m.content);
      const embeddings = await this.embeddingService.generateEmbeddings(texts);

      // Add to store
      for (let i = 0; i < newMessages.length; i++) {
        const msg = newMessages[i];
        store.entries.push({
          id: `st_${Date.now()}_${i}`,
          text: msg.content,
          textHash: this.embeddingService.getTextHash(msg.content),
          embedding: embeddings[i],
          source: 'short-term',
          createdAt: msg.timestamp,
        });
      }

      this.saveEmbeddings(chatId, store);
      this.logger.debug(`Indexed ${newMessages.length} short-term messages for ${chatId}`);
    } catch (error) {
      this.logger.error(`Failed to index short-term memory for ${chatId}: ${error}`);
    }
  }

  /**
   * Index long-term memory entries
   */
  async indexLongTermMemory(chatId: string, entries: LongTermMemoryEntry[]): Promise<void> {
    if (!this.embeddingService.isReady()) {
      this.logger.warn('EmbeddingService not ready, skipping indexing');
      return;
    }

    if (entries.length === 0) {
      return;
    }

    const store = this.loadEmbeddings(chatId);

    // Filter out entries that are already indexed
    const existingHashes = new Set(store.entries.map((e) => e.textHash));
    const newEntries = entries.filter((e) => {
      const hash = this.embeddingService.getTextHash(e.content);
      return !existingHashes.has(hash);
    });

    if (newEntries.length === 0) {
      return;
    }

    try {
      const texts = newEntries.map((e) => e.content);
      const embeddings = await this.embeddingService.generateEmbeddings(texts);

      for (let i = 0; i < newEntries.length; i++) {
        const entry = newEntries[i];
        store.entries.push({
          id: entry.id,
          text: entry.content,
          textHash: this.embeddingService.getTextHash(entry.content),
          embedding: embeddings[i],
          source: 'long-term',
          createdAt: entry.createdAt,
        });
      }

      this.saveEmbeddings(chatId, store);
      this.logger.debug(`Indexed ${newEntries.length} long-term entries for ${chatId}`);
    } catch (error) {
      this.logger.error(`Failed to index long-term memory for ${chatId}: ${error}`);
    }
  }

  /**
   * Perform keyword search
   */
  private keywordSearch(
    query: string,
    entries: { text: string; data: any }[],
  ): { score: number; data: any }[] {
    const queryWords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);

    if (queryWords.length === 0) {
      return [];
    }

    return entries
      .map((entry) => {
        const textLower = entry.text.toLowerCase();
        let matchCount = 0;

        for (const word of queryWords) {
          if (textLower.includes(word)) {
            matchCount++;
          }
        }

        return {
          score: matchCount / queryWords.length,
          data: entry.data,
        };
      })
      .filter((r) => r.score > 0);
  }

  /**
   * Search across all memory layers
   */
  async search(
    chatId: string,
    query: string,
    options: MemorySearchOptions = {},
  ): Promise<MemorySearchResult[]> {
    const { maxResults = 5, minScore = 0.3, sources = ['short-term', 'long-term'] } = options;

    if (!this.embeddingService.isReady()) {
      // Fallback to keyword-only search
      return this.keywordOnlySearch(chatId, query, maxResults, sources);
    }

    try {
      const store = this.loadEmbeddings(chatId);

      // Filter by source
      const relevantEntries = store.entries.filter((e) => sources.includes(e.source));

      if (relevantEntries.length === 0) {
        return [];
      }

      // Generate query embedding
      const queryEmbedding = await this.embeddingService.generateEmbedding(query);

      // Semantic search
      const semanticResults = this.embeddingService.findMostSimilar(
        queryEmbedding,
        relevantEntries.map((e) => ({
          embedding: e.embedding,
          data: e,
        })),
        maxResults * 2, // Get more for merging
        0, // No min score filter yet
      );

      // Keyword search
      const keywordResults = this.keywordSearch(
        query,
        relevantEntries.map((e) => ({
          text: e.text,
          data: e,
        })),
      );

      // Merge results with weighted scoring
      const merged = this.mergeResults(semanticResults, keywordResults, minScore);

      // Convert to MemorySearchResult format
      const results: MemorySearchResult[] = merged.slice(0, maxResults).map((r) => {
        const entry = r.data as EmbeddingEntry;
        return {
          content: entry.text,
          score: r.score,
          source: entry.source,
          timestamp: entry.createdAt,
        };
      });

      return results;
    } catch (error) {
      this.logger.error(`Search failed for ${chatId}: ${error}`);
      // Fallback to keyword search
      return this.keywordOnlySearch(chatId, query, maxResults, sources);
    }
  }

  /**
   * Fallback keyword-only search
   */
  private keywordOnlySearch(
    chatId: string,
    query: string,
    maxResults: number,
    sources: ('short-term' | 'long-term')[],
  ): MemorySearchResult[] {
    const results: MemorySearchResult[] = [];

    // Search long-term memory
    if (sources.includes('long-term')) {
      const longTermResults = this.longTermMemoryService.searchByKeyword(chatId, query);
      for (const entry of longTermResults.slice(0, maxResults)) {
        results.push({
          content: entry.content,
          score: 0.5, // Default keyword match score
          source: 'long-term',
          timestamp: entry.createdAt,
          category: entry.category,
          id: entry.id,
        });
      }
    }

    return results.slice(0, maxResults);
  }

  /**
   * Merge semantic and keyword results with weighting
   */
  private mergeResults(
    semanticResults: { score: number; data: any }[],
    keywordResults: { score: number; data: any }[],
    minScore: number,
  ): { score: number; data: any }[] {
    const scoreMap = new Map<string, { semanticScore: number; keywordScore: number; data: any }>();

    // Add semantic results
    for (const result of semanticResults) {
      const entry = result.data as EmbeddingEntry;
      scoreMap.set(entry.id, {
        semanticScore: result.score,
        keywordScore: 0,
        data: entry,
      });
    }

    // Add keyword results
    for (const result of keywordResults) {
      const entry = result.data as EmbeddingEntry;
      const existing = scoreMap.get(entry.id);
      if (existing) {
        existing.keywordScore = result.score;
      } else {
        scoreMap.set(entry.id, {
          semanticScore: 0,
          keywordScore: result.score,
          data: entry,
        });
      }
    }

    // Calculate combined scores
    const combined = Array.from(scoreMap.values())
      .map((r) => ({
        score: r.semanticScore * this.SEMANTIC_WEIGHT + r.keywordScore * this.KEYWORD_WEIGHT,
        data: r.data,
      }))
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score);

    return combined;
  }

  /**
   * Clear embeddings for a chat
   */
  clearEmbeddings(chatId: string): void {
    const emptyStore: EmbeddingsStore = {
      chatId,
      entries: [],
      lastUpdated: new Date().toISOString(),
    };
    this.saveEmbeddings(chatId, emptyStore);
    this.embeddingsCache.delete(chatId);
    this.logger.log(`Cleared embeddings for ${chatId}`);
  }

  /**
   * Remove short-term entries from embeddings (after compaction)
   */
  removeShortTermEmbeddings(chatId: string): void {
    const store = this.loadEmbeddings(chatId);
    store.entries = store.entries.filter((e) => e.source !== 'short-term');
    this.saveEmbeddings(chatId, store);
    this.logger.debug(`Removed short-term embeddings for ${chatId}`);
  }

  /**
   * Get embedding statistics
   */
  getStats(chatId: string): { total: number; shortTerm: number; longTerm: number } {
    const store = this.loadEmbeddings(chatId);
    return {
      total: store.entries.length,
      shortTerm: store.entries.filter((e) => e.source === 'short-term').length,
      longTerm: store.entries.filter((e) => e.source === 'long-term').length,
    };
  }
}
