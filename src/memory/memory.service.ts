/**
 * Conversation memory per chat. Persists recent messages and optional summary
 * to disk. The MAIN AGENT loads this before each turn (processMessage) and
 * saves the new assistant reply after. Used only by AgentService; no agent logic.
 *
 * Integrates with LongTermMemoryService for extracting important facts before
 * compaction or reset, and for semantic search via ChromaDB.
 */
import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { AiService } from '../ai/ai.service';
import { LongTermMemoryService } from './longterm-memory.service';
import { MemorySearchResult, MemorySearchOptions } from './memory.types';

export interface FileAttachment {
  fileId: string;
  fileName: string;
  filePath: string;
  mimeType: string;
  size?: number;
}

export interface MemoryMessage {
  role: 'user' | 'assistant' | 'summary';
  content: string;
  timestamp: string;
  attachments?: FileAttachment[]; // Optional file attachments for this message
}

export interface ChatMemory {
  chatId: string;
  messages: MemoryMessage[];
  lastActivity: string;
}

@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);
  private readonly dataDir: string;
  private readonly MAX_MESSAGES = 16;

  // In-memory cache of loaded memories
  private memoryCache: Map<string, ChatMemory> = new Map();

  constructor(
    @Inject(forwardRef(() => AiService))
    private readonly aiService: AiService,
    @Inject(forwardRef(() => LongTermMemoryService))
    private readonly longTermMemoryService: LongTermMemoryService,
  ) {
    this.dataDir = path.join(process.cwd(), 'data');
  }

  /**
   * Get the memory file path for a specific chat
   */
  private getMemoryPath(chatId: string): string {
    return path.join(this.dataDir, chatId, 'memory.json');
  }

  /**
   * Load memory for a specific chat from its JSON file
   */
  private loadMemoryForChat(chatId: string): ChatMemory {
    // Check cache first
    if (this.memoryCache.has(chatId)) {
      return this.memoryCache.get(chatId)!;
    }

    const memoryPath = this.getMemoryPath(chatId);

    try {
      if (fs.existsSync(memoryPath)) {
        const content = fs.readFileSync(memoryPath, 'utf-8');
        const memory: ChatMemory = JSON.parse(content);
        this.memoryCache.set(chatId, memory);
        return memory;
      }
    } catch (error) {
      this.logger.error(`Failed to load memory for chat ${chatId}: ${error}`);
    }

    // Return empty memory if not found
    const emptyMemory: ChatMemory = {
      chatId,
      messages: [],
      lastActivity: new Date().toISOString(),
    };
    this.memoryCache.set(chatId, emptyMemory);
    return emptyMemory;
  }

  /**
   * Save memory for a specific chat to its JSON file
   */
  private saveMemoryForChat(chatId: string, memory: ChatMemory): void {
    try {
      const chatDir = path.join(this.dataDir, chatId);
      if (!fs.existsSync(chatDir)) {
        fs.mkdirSync(chatDir, { recursive: true });
      }

      const memoryPath = this.getMemoryPath(chatId);
      fs.writeFileSync(memoryPath, JSON.stringify(memory, null, 2));

      // Update cache
      this.memoryCache.set(chatId, memory);
    } catch (error) {
      this.logger.error(`Failed to save memory for chat ${chatId}: ${error}`);
    }
  }

  /**
   * Get memory for a specific chat
   */
  getMemory(chatId: string): ChatMemory {
    return this.loadMemoryForChat(chatId);
  }

  /**
   * Get messages for a specific chat
   */
  getMessages(chatId: string): MemoryMessage[] {
    return this.getMemory(chatId).messages;
  }

  /**
   * Add a message to the chat memory
   * Automatically summarizes old messages if memory exceeds MAX_MESSAGES
   * @param chatId - The chat ID
   * @param role - The message role (user or assistant)
   * @param content - The message content
   * @param attachments - Optional file attachments associated with this message
   */
  async addMessage(
    chatId: string,
    role: 'user' | 'assistant',
    content: string,
    attachments?: FileAttachment[],
  ): Promise<void> {
    const memory = this.loadMemoryForChat(chatId);

    const message: MemoryMessage = {
      role,
      content,
      timestamp: new Date().toISOString(),
    };

    // Add attachments if provided
    if (attachments && attachments.length > 0) {
      message.attachments = attachments;
    }

    memory.messages.push(message);
    memory.lastActivity = new Date().toISOString();

    // Check if we need to summarize old messages
    if (memory.messages.length > this.MAX_MESSAGES) {
      await this.compactMemory(chatId, memory);
    }

    this.saveMemoryForChat(chatId, memory);
  }

  /**
   * Compact memory by summarizing oldest messages into a single summary.
   * Also extracts important facts to long-term memory before summarizing.
   */
  private async compactMemory(chatId: string, memory: ChatMemory): Promise<void> {
    if (memory.messages.length <= this.MAX_MESSAGES) {
      return;
    }

    // Keep more recent messages so "what about now?" / "that one" have clear referents
    const keepCount = 8;
    const messagesToSummarize = memory.messages.slice(0, memory.messages.length - keepCount);
    const recentMessages = memory.messages.slice(-keepCount);

    // Skip if nothing important to summarize
    if (messagesToSummarize.length === 0) {
      return;
    }

    this.logger.log(
      `Compacting memory for chat ${chatId}: summarizing ${messagesToSummarize.length} messages`,
    );

    try {
      // Extract important facts to long-term memory BEFORE summarizing
      await this.longTermMemoryService.extractAndSaveMemories(
        chatId,
        messagesToSummarize,
        'compaction',
      );

      // Generate summary of old messages (pass chatId for usage tracking)
      const summary = await this.aiService.summarizeConversation(messagesToSummarize, chatId);

      if (summary && summary.trim()) {
        // Replace old messages with a single summary message
        memory.messages = [
          {
            role: 'summary',
            content: summary,
            timestamp: new Date().toISOString(),
          },
          ...recentMessages,
        ];

        this.logger.log(
          `Memory compacted for chat ${chatId}: ${messagesToSummarize.length} messages → 1 summary`,
        );
      } else {
        // If no important content, just keep recent messages
        memory.messages = recentMessages;
        this.logger.log(
          `Memory trimmed for chat ${chatId}: removed ${messagesToSummarize.length} messages (nothing important)`,
        );
      }
    } catch (error) {
      this.logger.error(`Failed to compact memory for chat ${chatId}: ${error}`);
      // On error, just trim to keep recent messages
      memory.messages = recentMessages;
    }
  }

  /**
   * Reset/clear memory for a specific chat.
   * Extracts important facts to long-term memory before clearing.
   */
  async resetMemory(chatId: string): Promise<void> {
    const memory = this.loadMemoryForChat(chatId);

    // Extract important facts before clearing (if there are messages)
    if (memory.messages.length > 0) {
      try {
        const extractedCount = await this.longTermMemoryService.extractAndSaveMemories(
          chatId,
          memory.messages,
          'compaction',
        );

        if (extractedCount > 0) {
          this.logger.log(`Extracted ${extractedCount} facts to long-term memory before reset`);
        }
      } catch (error) {
        this.logger.warn(`Failed to extract facts before reset: ${error}`);
        // Continue with reset even if extraction fails
      }
    }

    // Reset the memory
    const emptyMemory: ChatMemory = {
      chatId,
      messages: [],
      lastActivity: new Date().toISOString(),
    };
    this.saveMemoryForChat(chatId, emptyMemory);
    this.logger.log(`Memory reset for chat ${chatId}`);
  }

  /**
   * Check if a chat has any memory
   */
  hasMemory(chatId: string): boolean {
    const memory = this.loadMemoryForChat(chatId);
    return memory.messages.length > 0;
  }

  /**
   * Get formatted messages for the agent (converts to the format expected by LangChain)
   */
  getFormattedMessages(chatId: string): Array<{ role: string; content: string }> {
    const messages = this.getMessages(chatId);

    return messages.map((msg) => {
      // Convert 'summary' role to a system-like context message
      if (msg.role === 'summary') {
        return {
          role: 'system',
          content: `[Previous conversation summary]: ${msg.content}`,
        };
      }
      return {
        role: msg.role === 'user' ? 'human' : 'ai',
        content: msg.content,
      };
    });
  }

  /**
   * Get enriched context by searching semantic memory for relevant past information.
   * Returns relevant memories that should be included in the agent's context.
   */
  async getEnrichedContext(
    chatId: string,
    query: string,
    options?: MemorySearchOptions,
  ): Promise<MemorySearchResult[]> {
    try {
      return await this.longTermMemoryService.searchMemories(chatId, query, {
        maxResults: options?.maxResults ?? 3,
        minScore: options?.minScore ?? 0.4,
      });
    } catch (error) {
      this.logger.warn(`Failed to get enriched context: ${error}`);
      return [];
    }
  }

  /**
   * Search memory (semantic search via ChromaDB) for relevant information.
   * Used by the memorySearch tool.
   */
  async searchMemory(
    chatId: string,
    query: string,
    options?: MemorySearchOptions,
  ): Promise<MemorySearchResult[]> {
    return this.longTermMemoryService.searchMemories(chatId, query, options);
  }

  /**
   * Get long-term memory service for direct access (used by tools)
   */
  getLongTermMemoryService(): LongTermMemoryService {
    return this.longTermMemoryService;
  }
}
