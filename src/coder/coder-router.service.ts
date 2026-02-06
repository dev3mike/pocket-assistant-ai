/**
 * Routes user/scheduled messages to the coder subagent when the task is coding-related.
 * Uses the LLM (via AiService) to classify whether a message is a coding task.
 */
import { Injectable } from '@nestjs/common';
import { AiService } from '../ai/ai.service';

@Injectable()
export class CoderRouterService {
  constructor(private readonly aiService: AiService) {}

  /**
   * Returns true if the LLM classifies the message as a coding-related task
   * (clone repo, edit files, git, PR review, run commands, etc.).
   */
  async isCodingTask(message: string, chatId?: string): Promise<boolean> {
    return this.aiService.isCodingTask(message, chatId);
  }
}
