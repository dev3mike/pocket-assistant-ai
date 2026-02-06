/**
 * Type definitions for the two-layer memory system.
 * Layer 1: Short-term conversation history (existing memory.json)
 * Layer 2: Long-term persistent facts/preferences (longterm-memory.json)
 */

/**
 * Categories for long-term memory entries
 */
export type MemoryCategory = 'fact' | 'preference' | 'decision' | 'context' | 'todo';

/**
 * Source of how a memory entry was created
 */
export type MemorySource = 'auto' | 'manual' | 'compaction';

/**
 * A single long-term memory entry
 */
export interface LongTermMemoryEntry {
  id: string;
  content: string;
  category: MemoryCategory;
  source: MemorySource;
  createdAt: string;
  tags?: string[];
}

/**
 * Storage format for long-term memory file (longterm-memory.json)
 */
export interface LongTermMemoryStore {
  chatId: string;
  entries: LongTermMemoryEntry[];
  lastUpdated: string;
}

/**
 * Cached embedding entry for semantic search
 */
export interface EmbeddingEntry {
  id: string;
  text: string;
  textHash: string; // For cache invalidation
  embedding: number[];
  source: 'short-term' | 'long-term';
  createdAt: string;
}

/**
 * Storage format for embeddings cache (embeddings.json)
 */
export interface EmbeddingsStore {
  chatId: string;
  entries: EmbeddingEntry[];
  lastUpdated: string;
}

/**
 * Result from memory search
 */
export interface MemorySearchResult {
  content: string;
  score: number;
  source: 'short-term' | 'long-term';
  timestamp: string;
  category?: MemoryCategory;
  id?: string;
}

/**
 * Options for memory search
 */
export interface MemorySearchOptions {
  maxResults?: number;
  minScore?: number;
  sources?: ('short-term' | 'long-term')[];
}

/**
 * Result from LLM extraction of important facts
 */
export interface ExtractedMemory {
  content: string;
  category: MemoryCategory;
  tags?: string[];
}
