/**
 * Key-value state storage per chat. Provides runtime state persistence for
 * scheduled tasks and cross-session data that shouldn't go in long-term memory.
 * Supports TTL (time-to-live) for auto-expiring entries.
 *
 * Use cases:
 * - Scheduled tasks storing previous values for comparison (e.g., last BTC price)
 * - Temporary context that should expire
 * - Cross-session state that isn't appropriate for long-term memory
 *
 * Includes background cleanup job that runs every 15 minutes to remove expired entries.
 */
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export interface StateEntry {
  key: string;
  value: any;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string; // ISO date string, optional TTL
}

interface StateData {
  chatId: string;
  entries: Record<string, StateEntry>;
  lastUpdated: string;
}

@Injectable()
export class StateService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StateService.name);
  private readonly dataDir: string;
  private readonly CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

  // In-memory cache of loaded states
  private stateCache: Map<string, StateData> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.dataDir = path.join(process.cwd(), 'data');
  }

  onModuleInit() {
    this.startCleanupJob();
    this.logger.log('State service initialized with cleanup job (every 15 min)');
  }

  onModuleDestroy() {
    this.stopCleanupJob();
  }

  /**
   * Start the background cleanup job
   */
  private startCleanupJob(): void {
    // Run cleanup immediately on startup
    this.cleanupAllExpiredStates();

    // Then run every 15 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanupAllExpiredStates();
    }, this.CLEANUP_INTERVAL_MS);
  }

  /**
   * Stop the background cleanup job
   */
  private stopCleanupJob(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      this.logger.log('State cleanup job stopped');
    }
  }

  /**
   * Clean up expired entries across all chat state files
   */
  private cleanupAllExpiredStates(): void {
    try {
      if (!fs.existsSync(this.dataDir)) {
        return;
      }

      const entries = fs.readdirSync(this.dataDir, { withFileTypes: true });
      let totalRemoved = 0;

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const chatId = entry.name;
        const statePath = this.getStatePath(chatId);

        if (fs.existsSync(statePath)) {
          const removed = this.cleanupExpiredForChat(chatId);
          totalRemoved += removed;
        }
      }

      if (totalRemoved > 0) {
        this.logger.log(`State cleanup: removed ${totalRemoved} expired entries`);
      }
    } catch (error) {
      this.logger.error(`State cleanup failed: ${error}`);
    }
  }

  /**
   * Clean up expired entries for a specific chat and save if changed
   * @returns Number of entries removed
   */
  private cleanupExpiredForChat(chatId: string): number {
    const state = this.loadStateForChat(chatId);
    const now = new Date();
    let removedCount = 0;

    for (const key of Object.keys(state.entries)) {
      const entry = state.entries[key];
      if (entry.expiresAt && new Date(entry.expiresAt) < now) {
        delete state.entries[key];
        removedCount++;
      }
    }

    if (removedCount > 0) {
      state.lastUpdated = now.toISOString();
      this.saveStateForChat(chatId, state);
    }

    return removedCount;
  }

  /**
   * Get the state file path for a specific chat
   */
  private getStatePath(chatId: string): string {
    return path.join(this.dataDir, chatId, 'state.json');
  }

  /**
   * Ensure the user directory exists
   */
  private ensureUserDir(chatId: string): string {
    const userDir = path.join(this.dataDir, chatId);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    return userDir;
  }

  /**
   * Load state for a specific chat from its JSON file
   */
  private loadStateForChat(chatId: string): StateData {
    // Check cache first
    if (this.stateCache.has(chatId)) {
      return this.stateCache.get(chatId)!;
    }

    const statePath = this.getStatePath(chatId);

    try {
      if (fs.existsSync(statePath)) {
        const content = fs.readFileSync(statePath, 'utf-8');
        const state: StateData = JSON.parse(content);
        this.stateCache.set(chatId, state);
        return state;
      }
    } catch (error) {
      this.logger.error(`Failed to load state for chat ${chatId}: ${error}`);
    }

    // Return empty state if not found
    const emptyState: StateData = {
      chatId,
      entries: {},
      lastUpdated: new Date().toISOString(),
    };
    this.stateCache.set(chatId, emptyState);
    return emptyState;
  }

  /**
   * Save state for a specific chat to its JSON file
   */
  private saveStateForChat(chatId: string, state: StateData): void {
    try {
      this.ensureUserDir(chatId);
      const statePath = this.getStatePath(chatId);
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      this.stateCache.set(chatId, state);
    } catch (error) {
      this.logger.error(`Failed to save state for chat ${chatId}: ${error}`);
    }
  }

  /**
   * Check if an entry has expired
   */
  private isExpired(entry: StateEntry): boolean {
    if (!entry.expiresAt) {
      return false;
    }
    return new Date() > new Date(entry.expiresAt);
  }

  // ===== Public API =====

  /**
   * Set a value in the state store
   * @param chatId - The chat ID
   * @param key - The key to store the value under
   * @param value - The value to store (will be JSON serialized)
   * @param ttlMinutes - Optional time-to-live in minutes
   */
  setState(chatId: string, key: string, value: any, ttlMinutes?: number): StateEntry {
    const state = this.loadStateForChat(chatId);
    const now = new Date();

    const entry: StateEntry = {
      key,
      value,
      createdAt: state.entries[key]?.createdAt || now.toISOString(),
      updatedAt: now.toISOString(),
    };

    if (ttlMinutes && ttlMinutes > 0) {
      const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);
      entry.expiresAt = expiresAt.toISOString();
    }

    state.entries[key] = entry;
    state.lastUpdated = now.toISOString();

    this.saveStateForChat(chatId, state);
    this.logger.log(`State set for chat ${chatId}: ${key}${ttlMinutes ? ` (TTL: ${ttlMinutes}m)` : ''}`);

    return entry;
  }

  /**
   * Get a value from the state store
   * @param chatId - The chat ID
   * @param key - The key to retrieve
   * @returns The value, or null if not found or expired
   */
  getState(chatId: string, key: string): any | null {
    const state = this.loadStateForChat(chatId);
    const entry = state.entries[key];

    if (!entry) {
      return null;
    }

    // Check if expired
    if (this.isExpired(entry)) {
      delete state.entries[key];
      state.lastUpdated = new Date().toISOString();
      this.saveStateForChat(chatId, state);
      this.logger.debug(`State entry expired and removed: ${key}`);
      return null;
    }

    return entry.value;
  }

  /**
   * Get a state entry with metadata
   * @param chatId - The chat ID
   * @param key - The key to retrieve
   * @returns The full entry, or null if not found or expired
   */
  getStateEntry(chatId: string, key: string): StateEntry | null {
    const state = this.loadStateForChat(chatId);
    const entry = state.entries[key];

    if (!entry) {
      return null;
    }

    // Check if expired
    if (this.isExpired(entry)) {
      delete state.entries[key];
      state.lastUpdated = new Date().toISOString();
      this.saveStateForChat(chatId, state);
      return null;
    }

    return entry;
  }

  /**
   * Delete a value from the state store
   * @param chatId - The chat ID
   * @param key - The key to delete
   * @returns True if the key existed and was deleted
   */
  deleteState(chatId: string, key: string): boolean {
    const state = this.loadStateForChat(chatId);

    if (!state.entries[key]) {
      return false;
    }

    delete state.entries[key];
    state.lastUpdated = new Date().toISOString();
    this.saveStateForChat(chatId, state);

    this.logger.log(`State deleted for chat ${chatId}: ${key}`);
    return true;
  }

  /**
   * List all keys in the state store for a chat
   * @param chatId - The chat ID
   * @returns Array of state entries (excluding expired ones)
   */
  listState(chatId: string): StateEntry[] {
    // Clean up expired entries first
    this.cleanupExpiredForChat(chatId);

    const state = this.loadStateForChat(chatId);
    return Object.values(state.entries);
  }

  /**
   * Check if a key exists in the state store
   * @param chatId - The chat ID
   * @param key - The key to check
   * @returns True if the key exists and is not expired
   */
  hasState(chatId: string, key: string): boolean {
    return this.getState(chatId, key) !== null;
  }

  /**
   * Clear all state for a chat
   * @param chatId - The chat ID
   */
  clearState(chatId: string): void {
    const state: StateData = {
      chatId,
      entries: {},
      lastUpdated: new Date().toISOString(),
    };
    this.saveStateForChat(chatId, state);
    this.logger.log(`State cleared for chat ${chatId}`);
  }
}
