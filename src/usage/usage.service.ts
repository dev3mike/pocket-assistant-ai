import { Injectable, Logger } from '@nestjs/common';
import { AIMessage } from '@langchain/core/messages';
import * as fs from 'fs';
import * as path from 'path';

export interface MonthlyUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface UsageData {
  [monthKey: string]: MonthlyUsage; // e.g., "2026-01": { totalTokens: 1000, totalCost: 0.05 }
}

export interface ExtractedUsage {
  inputTokens: number;
  outputTokens: number;
}

@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);
  private readonly dataDir: string;

  // In-memory cache of loaded usage data
  private usageCache: Map<string, UsageData> = new Map();

  constructor() {
    this.dataDir = path.join(process.cwd(), 'data');
  }

  /**
   * Get the current month key in format YYYY-MM
   */
  private getCurrentMonthKey(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }

  /**
   * Get the usage file path for a specific chat
   */
  private getUsagePath(chatId: string): string {
    return path.join(this.dataDir, chatId, 'usage.json');
  }

  /**
   * Load usage data for a specific chat from its JSON file
   */
  private loadUsageForChat(chatId: string): UsageData {
    // Check cache first
    if (this.usageCache.has(chatId)) {
      return this.usageCache.get(chatId)!;
    }

    const usagePath = this.getUsagePath(chatId);

    try {
      if (fs.existsSync(usagePath)) {
        const content = fs.readFileSync(usagePath, 'utf-8');
        const usage: UsageData = JSON.parse(content);
        this.usageCache.set(chatId, usage);
        return usage;
      }
    } catch (error) {
      this.logger.error(`Failed to load usage for chat ${chatId}: ${error}`);
    }

    // Return empty usage if not found
    const emptyUsage: UsageData = {};
    this.usageCache.set(chatId, emptyUsage);
    return emptyUsage;
  }

  /**
   * Save usage data for a specific chat to its JSON file
   */
  private saveUsageForChat(chatId: string, usage: UsageData): void {
    try {
      const chatDir = path.join(this.dataDir, chatId);
      if (!fs.existsSync(chatDir)) {
        fs.mkdirSync(chatDir, { recursive: true });
      }

      const usagePath = this.getUsagePath(chatId);
      fs.writeFileSync(usagePath, JSON.stringify(usage, null, 2));

      // Update cache
      this.usageCache.set(chatId, usage);
    } catch (error) {
      this.logger.error(`Failed to save usage for chat ${chatId}: ${error}`);
    }
  }

  /**
   * Extract tokens from an AIMessage response
   */
  extractUsageFromResponse(response: AIMessage): ExtractedUsage {
    let inputTokens = 0;
    let outputTokens = 0;

    // Get tokens from usage_metadata (LangChain's standardized format)
    if (response.usage_metadata) {
      inputTokens = response.usage_metadata.input_tokens || 0;
      outputTokens = response.usage_metadata.output_tokens || 0;
    }

    // Fallback: check response_metadata.tokenUsage (OpenRouter's format)
    const metadata = response.response_metadata as Record<string, any>;
    if (metadata?.tokenUsage && inputTokens === 0 && outputTokens === 0) {
      inputTokens = metadata.tokenUsage.promptTokens || 0;
      outputTokens = metadata.tokenUsage.completionTokens || 0;
    }

    return { inputTokens, outputTokens };
  }

  /**
   * Record usage directly from an AIMessage response
   */
  recordUsageFromResponse(chatId: string | undefined | null, response: AIMessage): void {
    if (!chatId) return;

    const { inputTokens, outputTokens } = this.extractUsageFromResponse(response);

    if (inputTokens > 0 || outputTokens > 0) {
      this.recordUsage(chatId, inputTokens, outputTokens);
    }
  }

  /**
   * Record token usage for a chat
   */
  recordUsage(chatId: string, inputTokens: number, outputTokens: number): void {
    const usage = this.loadUsageForChat(chatId);
    const monthKey = this.getCurrentMonthKey();

    if (!usage[monthKey]) {
      usage[monthKey] = {
        inputTokens: 0,
        outputTokens: 0,
      };
    }

    usage[monthKey].inputTokens += inputTokens;
    usage[monthKey].outputTokens += outputTokens;

    this.saveUsageForChat(chatId, usage);

    this.logger.debug(
      `Recorded usage for chat ${chatId}: +${inputTokens} in, +${outputTokens} out (${monthKey} total: ${usage[monthKey].inputTokens} in, ${usage[monthKey].outputTokens} out)`,
    );
  }

  /**
   * Get usage data for a specific chat
   */
  getUsage(chatId: string): UsageData {
    return this.loadUsageForChat(chatId);
  }

  /**
   * Get usage for the current month
   */
  getCurrentMonthUsage(chatId: string): MonthlyUsage {
    const usage = this.loadUsageForChat(chatId);
    const monthKey = this.getCurrentMonthKey();

    return usage[monthKey] || { inputTokens: 0, outputTokens: 0 };
  }

  /**
   * Get usage for a specific month
   */
  getMonthUsage(chatId: string, monthKey: string): MonthlyUsage {
    const usage = this.loadUsageForChat(chatId);
    return usage[monthKey] || { inputTokens: 0, outputTokens: 0 };
  }

  /**
   * Get total usage across all months
   */
  getTotalUsage(chatId: string): MonthlyUsage {
    const usage = this.loadUsageForChat(chatId);

    let inputTokens = 0;
    let outputTokens = 0;

    for (const monthData of Object.values(usage)) {
      inputTokens += monthData.inputTokens;
      outputTokens += monthData.outputTokens;
    }

    return { inputTokens, outputTokens };
  }

  /**
   * Clear the usage cache for a chat (useful for testing)
   */
  clearCache(chatId?: string): void {
    if (chatId) {
      this.usageCache.delete(chatId);
    } else {
      this.usageCache.clear();
    }
  }
}
