/**
 * Type definitions for the two-layer memory system.
 * Layer 1: Short-term conversation history (memory.json)
 * Layer 2: Long-term persistent facts/preferences (ChromaDB)
 */

/**
 * Categories for long-term memory entries
 */
export type MemoryCategory = 'fact' | 'preference' | 'decision' | 'context' | 'todo' | 'file';

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
  metadata?: Record<string, any>; // Additional data (e.g., file info for 'file' category)
}

/**
 * Result from memory search
 */
export interface MemorySearchResult {
  id?: string;
  content: string;
  score: number;
  source: 'short-term' | 'long-term';
  timestamp: string;
  category?: MemoryCategory;
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
