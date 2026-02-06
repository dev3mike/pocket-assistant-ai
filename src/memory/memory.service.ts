/**
 * Conversation memory per chat. Persists recent messages and optional summary
 * to disk. The MAIN AGENT loads this before each turn (processMessage) and
 * saves the new assistant reply after. Used only by AgentService; no agent logic.
 */
import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { AiService } from '../ai/ai.service';

export interface MemoryMessage {
  role: 'user' | 'assistant' | 'summary';
  content: string;
  timestamp: string;
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
   */
  async addMessage(chatId: string, role: 'user' | 'assistant', content: string): Promise<void> {
    const memory = this.loadMemoryForChat(chatId);

    memory.messages.push({
      role,
      content,
      timestamp: new Date().toISOString(),
    });
    memory.lastActivity = new Date().toISOString();

    // Check if we need to summarize old messages
    if (memory.messages.length > this.MAX_MESSAGES) {
      await this.compactMemory(chatId, memory);
    }

    this.saveMemoryForChat(chatId, memory);
  }

  /**
   * Compact memory by summarizing oldest messages into a single summary
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

    this.logger.log(`Compacting memory for chat ${chatId}: summarizing ${messagesToSummarize.length} messages`);

    try {
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

        this.logger.log(`Memory compacted for chat ${chatId}: ${messagesToSummarize.length} messages → 1 summary`);
      } else {
        // If no important content, just keep recent messages
        memory.messages = recentMessages;
        this.logger.log(`Memory trimmed for chat ${chatId}: removed ${messagesToSummarize.length} messages (nothing important)`);
      }
    } catch (error) {
      this.logger.error(`Failed to compact memory for chat ${chatId}: ${error}`);
      // On error, just trim to keep recent messages
      memory.messages = recentMessages;
    }
  }

  /**
   * Reset/clear memory for a specific chat
   */
  resetMemory(chatId: string): void {
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
}
