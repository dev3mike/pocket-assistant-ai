/**
 * User profile and onboarding. Stores per-chat "soul" data (AI name, character,
 * user name, etc.) and runs the onboarding flow (questions, then save). Used by
 * the MAIN AGENT (for getProfile/updateProfile tools and system prompt) and by
 * TelegramUpdate (to decide whether to show onboarding or pass messages to the
 * agent). No agent loop; just state and AI-generated onboarding replies via AiService.
 */
import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { AiService } from '../ai/ai.service';

export interface SoulData {
  aiName: string;
  aiCharacter: string;
  aiEmoji: string;
  userName: string;
  userDescription: string;
  additionalContext: string;
  createdAt: string;
  updatedAt: string;
}

export interface OnboardingState {
  step: 'ai_name' | 'ai_character' | 'ai_emoji' | 'user_name' | 'user_description' | 'additional' | 'refining' | 'complete';
  data: Partial<SoulData>;
}

// Questions for each step
const QUESTIONS = {
  ai_name: 'What would you like to call me?',
  ai_character: 'What should my personality/character be like?',
  ai_emoji: 'What should my signature emoji be? 🤔',
  user_name: "What's your name?",
  user_description: 'Tell me about yourself - your location, job, interests, etc.',
  additional: 'Any additional context or preferences I should know about?',
};

@Injectable()
export class SoulService {
  private readonly logger = new Logger(SoulService.name);
  private readonly dataDir: string;
  private readonly onboardingStates: Map<string, OnboardingState> = new Map();

  constructor(private readonly aiService: AiService) {
    this.dataDir = path.join(process.cwd(), 'data');
    this.ensureDataDirectory();
  }

  private ensureDataDirectory(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  private getUserDir(chatId: string): string {
    const userDir = path.join(this.dataDir, chatId);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    return userDir;
  }

  private getSoulPath(chatId: string): string {
    return path.join(this.getUserDir(chatId), 'soul.json');
  }

  /**
   * Check if user has completed onboarding
   */
  hasCompletedOnboarding(chatId: string): boolean {
    return fs.existsSync(this.getSoulPath(chatId));
  }

  /**
   * Get soul data for a user
   */
  getSoulData(chatId: string): SoulData | null {
    const soulPath = this.getSoulPath(chatId);

    if (!fs.existsSync(soulPath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(soulPath, 'utf-8');
      return JSON.parse(content) as SoulData;
    } catch (error) {
      this.logger.error(`Failed to read soul data for ${chatId}: ${error}`);
      return null;
    }
  }

  /**
   * Save soul data for a user
   */
  saveSoulData(chatId: string, data: SoulData): void {
    const soulPath = this.getSoulPath(chatId);

    try {
      fs.writeFileSync(soulPath, JSON.stringify(data, null, 2));
      this.logger.log(`Soul data saved for chat ${chatId}`);
    } catch (error) {
      this.logger.error(`Failed to save soul data for ${chatId}: ${error}`);
      throw error;
    }
  }

  /**
   * Update specific fields in soul data
   */
  updateSoulData(chatId: string, updates: Partial<SoulData>): SoulData | null {
    const existing = this.getSoulData(chatId);

    if (!existing) {
      return null;
    }

    const updated: SoulData = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    this.saveSoulData(chatId, updated);
    return updated;
  }

  /**
   * Delete soul data for a user (reset profile)
   */
  deleteSoulData(chatId: string): boolean {
    const soulPath = this.getSoulPath(chatId);

    if (!fs.existsSync(soulPath)) {
      return false;
    }

    try {
      fs.unlinkSync(soulPath);
      this.logger.log(`Soul data deleted for chat ${chatId}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to delete soul data for ${chatId}: ${error}`);
      return false;
    }
  }

  /**
   * Get the formatted soul context for the system prompt
   */
  getSoulContext(chatId: string): string | null {
    const soul = this.getSoulData(chatId);

    if (!soul) {
      return null;
    }

    return `## Your Identity
You are "${soul.aiName}" with the following personality: ${soul.aiCharacter}
Your signature emoji is: ${soul.aiEmoji || '🤖'}

## About the User
The user's name is "${soul.userName}". ${soul.userDescription}

## Additional Context
${soul.additionalContext || 'None'}`;
  }

  // ===== Onboarding Flow =====

  /**
   * Start onboarding for a user
   */
  async startOnboarding(chatId: string): Promise<string> {
    this.onboardingStates.set(chatId, {
      step: 'ai_name',
      data: {},
    });

    // Use AI to generate the welcome message
    try {
      const response = await this.aiService.generateOnboardingResponse(
        'start',
        '',
        QUESTIONS.ai_name,
        chatId,
      );
      return response;
    } catch {
      return `Let's set up your AI assistant. ${QUESTIONS.ai_name}`;
    }
  }

  /**
   * Check if user is in onboarding
   */
  isOnboarding(chatId: string): boolean {
    const state = this.onboardingStates.get(chatId);
    return state !== undefined && state.step !== 'complete';
  }

  /**
   * Process onboarding response (async for AI-generated responses)
   */
  async processOnboardingResponse(
    chatId: string,
    response: string,
  ): Promise<{ message: string; complete: boolean }> {
    const state = this.onboardingStates.get(chatId);

    if (!state) {
      return { message: 'No onboarding in progress.', complete: true };
    }

    switch (state.step) {
      case 'ai_name': {
        state.data.aiName = response.trim();
        state.step = 'ai_character';
        const message = await this.aiService.generateOnboardingResponse(
          'chose AI name',
          response,
          QUESTIONS.ai_character,
          chatId,
        );
        return { message, complete: false };
      }

      case 'ai_character': {
        state.data.aiCharacter = response.trim();
        state.step = 'ai_emoji';
        const message = await this.aiService.generateOnboardingResponse(
          'described AI personality',
          response,
          QUESTIONS.ai_emoji,
          chatId,
        );
        return { message, complete: false };
      }

      case 'ai_emoji': {
        // Convert the user's input to an emoji (handles both direct emoji and descriptions)
        state.data.aiEmoji = await this.aiService.convertToEmoji(response.trim(), chatId);
        state.step = 'user_name';
        const message = await this.aiService.generateOnboardingResponse(
          'chose signature emoji',
          state.data.aiEmoji, // Show the actual emoji in the response
          QUESTIONS.user_name,
          chatId,
        );
        return { message, complete: false };
      }

      case 'user_name': {
        state.data.userName = response.trim();
        state.step = 'user_description';
        const message = await this.aiService.generateOnboardingResponse(
          'shared their name',
          response,
          QUESTIONS.user_description,
          chatId,
        );
        return { message, complete: false };
      }

      case 'user_description': {
        state.data.userDescription = response.trim();
        state.step = 'additional';
        const message = await this.aiService.generateOnboardingResponse(
          'described themselves',
          response,
          QUESTIONS.additional,
          chatId,
        );
        return { message, complete: false };
      }

      case 'additional': {
        state.data.additionalContext = response.toLowerCase() === 'none' ? '' : response.trim();
        state.step = 'refining';

        // Refine the soul data using AI
        const refined = await this.aiService.refineSoulData({
          aiName: state.data.aiName!,
          aiCharacter: state.data.aiCharacter!,
          userName: state.data.userName!,
          userDescription: state.data.userDescription!,
          additionalContext: state.data.additionalContext || '',
        }, chatId);

        // Save the refined soul data
        const now = new Date().toISOString();
        const soulData: SoulData = {
          aiName: state.data.aiName!,
          aiCharacter: refined.aiCharacter,
          aiEmoji: state.data.aiEmoji || '🤖',
          userName: state.data.userName!,
          userDescription: refined.userDescription,
          additionalContext: refined.additionalContext,
          createdAt: now,
          updatedAt: now,
        };

        this.saveSoulData(chatId, soulData);
        this.onboardingStates.delete(chatId);

        // Generate completion message
        const completionMessage = await this.aiService.generateOnboardingComplete({
          aiName: soulData.aiName,
          aiCharacter: soulData.aiCharacter,
          aiEmoji: soulData.aiEmoji,
          userName: soulData.userName,
        }, chatId);

        return {
          message: completionMessage,
          complete: true,
        };
      }

      default:
        return { message: 'Something went wrong. Please /start again.', complete: true };
    }
  }

  /**
   * Cancel onboarding
   */
  cancelOnboarding(chatId: string): void {
    this.onboardingStates.delete(chatId);
  }
}
