/**
 * Notepad type definitions
 * Generic persistent notepad system for agents to track data across runs
 */

/**
 * Data log entry for structured data tracking (e.g., prices, metrics)
 */
export interface NotepadDataEntry {
  timestamp: string;
  entry: Record<string, any>;
}

/**
 * Notepad - agent-managed memory for tracking data across runs
 *
 * The agent can:
 * - Read/write free-form notes for summaries and decisions
 * - Append to dataLog for time-series data (prices, metrics, etc.)
 * - Update keyValues for quick reference (thresholds, current status)
 */
export interface Notepad {
  /** Unique identifier for this notepad */
  id: string;
  /** Optional category for organization (e.g., 'schedule', 'coder', 'browser') */
  category?: string;
  /** Optional human-readable name/description */
  name?: string;
  /** Free-form notes the agent can read/write (summaries, decisions, reasoning) */
  notes: string;
  /** Structured data log - agent appends entries, system keeps last N */
  dataLog: NotepadDataEntry[];
  /** Quick reference key-value pairs (e.g., lastPrice, trend, decision) */
  keyValues: Record<string, any>;
  /** Creation timestamp */
  createdAt: string;
  /** Last update timestamp */
  lastUpdated: string;
}

/**
 * Notepad summary for listing (without full content)
 */
export interface NotepadSummary {
  id: string;
  category?: string;
  name?: string;
  dataLogCount: number;
  keyValueKeys: string[];
  hasNotes: boolean;
  createdAt: string;
  lastUpdated: string;
}

/**
 * Options for updating a notepad
 */
export interface NotepadUpdateOptions {
  /** Replace all notes with new content */
  notes?: string;
  /** Append to existing notes */
  appendToNotes?: string;
  /** Add a timestamped data entry */
  addDataEntry?: Record<string, any>;
  /** Update key-value pairs (merged with existing) */
  keyValues?: Record<string, any>;
  /** Update the name/description */
  name?: string;
}

/**
 * Options for creating a new notepad
 */
export interface NotepadCreateOptions {
  /** Optional category for organization */
  category?: string;
  /** Optional human-readable name/description */
  name?: string;
  /** Initial notes */
  notes?: string;
  /** Initial key-value pairs */
  keyValues?: Record<string, any>;
}
