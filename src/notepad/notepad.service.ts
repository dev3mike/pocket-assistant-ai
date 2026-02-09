/**
 * NOTEPAD SERVICE - Generic persistent notepad system
 *
 * Provides a flexible notepad system for any agent to track data across runs.
 * Each notepad has:
 * - notes: Free-form text for summaries and decisions
 * - keyValues: Quick reference key-value pairs
 * - dataLog: Time-series data entries
 *
 * Storage: data/{chatId}/notepads/{notepadId}.json
 */
import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import {
  Notepad,
  NotepadSummary,
  NotepadUpdateOptions,
  NotepadCreateOptions,
} from './notepad.types';

@Injectable()
export class NotepadService {
  private readonly logger = new Logger(NotepadService.name);
  private readonly dataDir: string;
  private readonly MAX_DATA_LOG_ENTRIES = 100;

  constructor() {
    this.dataDir = path.join(process.cwd(), 'data');
  }

  /**
   * Get the notepads directory for a chat
   */
  private getNotepadsDir(chatId: string): string {
    return path.join(this.dataDir, chatId, 'notepads');
  }

  /**
   * Get the file path for a specific notepad
   */
  private getNotepadPath(chatId: string, notepadId: string): string {
    // Sanitize notepadId to prevent path traversal
    const safeId = notepadId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.getNotepadsDir(chatId), `${safeId}.json`);
  }

  /**
   * Ensure the notepads directory exists
   */
  private ensureNotepadsDir(chatId: string): void {
    const dir = this.getNotepadsDir(chatId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Create a new notepad
   */
  createNotepad(
    chatId: string,
    notepadId: string,
    options?: NotepadCreateOptions,
  ): Notepad {
    this.ensureNotepadsDir(chatId);

    const now = new Date().toISOString();
    const notepad: Notepad = {
      id: notepadId,
      category: options?.category,
      name: options?.name,
      notes: options?.notes || '',
      dataLog: [],
      keyValues: options?.keyValues || {},
      createdAt: now,
      lastUpdated: now,
    };

    this.saveNotepad(chatId, notepad);
    this.logger.log(`Created notepad ${notepadId} for chat ${chatId}`);
    return notepad;
  }

  /**
   * Load a notepad by ID
   * Returns null if not found
   */
  loadNotepad(chatId: string, notepadId: string): Notepad | null {
    const notepadPath = this.getNotepadPath(chatId, notepadId);

    try {
      if (fs.existsSync(notepadPath)) {
        const content = fs.readFileSync(notepadPath, 'utf-8');
        const parsed = JSON.parse(content);
        // Ensure all fields exist (for backwards compatibility)
        return {
          id: parsed.id || notepadId,
          category: parsed.category,
          name: parsed.name,
          notes: parsed.notes || '',
          dataLog: parsed.dataLog || [],
          keyValues: parsed.keyValues || {},
          createdAt: parsed.createdAt || new Date().toISOString(),
          lastUpdated: parsed.lastUpdated || new Date().toISOString(),
        };
      }
    } catch (error) {
      this.logger.error(`Failed to load notepad ${notepadId}: ${error}`);
    }

    return null;
  }

  /**
   * Get or create a notepad
   * If the notepad doesn't exist, creates it with the provided options
   */
  getOrCreateNotepad(
    chatId: string,
    notepadId: string,
    options?: NotepadCreateOptions,
  ): Notepad {
    const existing = this.loadNotepad(chatId, notepadId);
    if (existing) {
      return existing;
    }
    return this.createNotepad(chatId, notepadId, options);
  }

  /**
   * Save a notepad to disk
   */
  private saveNotepad(chatId: string, notepad: Notepad): void {
    try {
      this.ensureNotepadsDir(chatId);

      // Limit dataLog size to prevent bloat
      if (notepad.dataLog.length > this.MAX_DATA_LOG_ENTRIES) {
        notepad.dataLog = notepad.dataLog.slice(-this.MAX_DATA_LOG_ENTRIES);
      }

      notepad.lastUpdated = new Date().toISOString();
      const notepadPath = this.getNotepadPath(chatId, notepad.id);
      fs.writeFileSync(notepadPath, JSON.stringify(notepad, null, 2));
    } catch (error) {
      this.logger.error(`Failed to save notepad ${notepad.id}: ${error}`);
    }
  }

  /**
   * Update a notepad with new data
   * Creates the notepad if it doesn't exist
   */
  updateNotepad(
    chatId: string,
    notepadId: string,
    updates: NotepadUpdateOptions,
  ): Notepad {
    let notepad = this.loadNotepad(chatId, notepadId);

    if (!notepad) {
      // Create new notepad with updates
      notepad = this.createNotepad(chatId, notepadId, {
        notes: updates.notes,
        name: updates.name,
        keyValues: updates.keyValues,
      });
    }

    // Apply updates
    if (updates.notes !== undefined) {
      notepad.notes = updates.notes;
    }

    if (updates.appendToNotes) {
      notepad.notes = notepad.notes
        ? `${notepad.notes}\n\n${updates.appendToNotes}`
        : updates.appendToNotes;
    }

    if (updates.addDataEntry) {
      notepad.dataLog.push({
        timestamp: new Date().toISOString(),
        entry: updates.addDataEntry,
      });
    }

    if (updates.keyValues) {
      notepad.keyValues = { ...notepad.keyValues, ...updates.keyValues };
    }

    if (updates.name !== undefined) {
      notepad.name = updates.name;
    }

    this.saveNotepad(chatId, notepad);
    return notepad;
  }

  /**
   * Delete a notepad
   */
  deleteNotepad(chatId: string, notepadId: string): boolean {
    try {
      const notepadPath = this.getNotepadPath(chatId, notepadId);
      if (fs.existsSync(notepadPath)) {
        fs.unlinkSync(notepadPath);
        this.logger.log(`Deleted notepad ${notepadId} for chat ${chatId}`);
        return true;
      }
    } catch (error) {
      this.logger.error(`Failed to delete notepad ${notepadId}: ${error}`);
    }
    return false;
  }

  /**
   * List all notepads for a chat
   */
  listNotepads(chatId: string, category?: string): NotepadSummary[] {
    const notepadsDir = this.getNotepadsDir(chatId);
    const summaries: NotepadSummary[] = [];

    try {
      if (!fs.existsSync(notepadsDir)) {
        return summaries;
      }

      const files = fs.readdirSync(notepadsDir);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        try {
          const content = fs.readFileSync(path.join(notepadsDir, file), 'utf-8');
          const notepad = JSON.parse(content) as Notepad;

          // Filter by category if specified
          if (category && notepad.category !== category) {
            continue;
          }

          summaries.push({
            id: notepad.id,
            category: notepad.category,
            name: notepad.name,
            dataLogCount: notepad.dataLog?.length || 0,
            keyValueKeys: Object.keys(notepad.keyValues || {}),
            hasNotes: !!(notepad.notes && notepad.notes.trim()),
            createdAt: notepad.createdAt,
            lastUpdated: notepad.lastUpdated,
          });
        } catch (error) {
          this.logger.warn(`Failed to parse notepad file ${file}: ${error}`);
        }
      }

      // Sort by last updated (most recent first)
      summaries.sort((a, b) =>
        new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime()
      );
    } catch (error) {
      this.logger.error(`Failed to list notepads for chat ${chatId}: ${error}`);
    }

    return summaries;
  }

  /**
   * Clear a specific key from keyValues
   */
  clearKeyValue(chatId: string, notepadId: string, key: string): boolean {
    const notepad = this.loadNotepad(chatId, notepadId);
    if (!notepad) return false;

    if (key in notepad.keyValues) {
      delete notepad.keyValues[key];
      this.saveNotepad(chatId, notepad);
      return true;
    }
    return false;
  }

  /**
   * Clear all data from a notepad (but keep the notepad)
   */
  clearNotepad(chatId: string, notepadId: string): Notepad | null {
    const notepad = this.loadNotepad(chatId, notepadId);
    if (!notepad) return null;

    notepad.notes = '';
    notepad.dataLog = [];
    notepad.keyValues = {};
    this.saveNotepad(chatId, notepad);
    return notepad;
  }

  /**
   * Get recent data entries from a notepad
   */
  getRecentDataEntries(
    chatId: string,
    notepadId: string,
    count: number = 10,
  ): Notepad['dataLog'] {
    const notepad = this.loadNotepad(chatId, notepadId);
    if (!notepad) return [];
    return notepad.dataLog.slice(-count);
  }
}
