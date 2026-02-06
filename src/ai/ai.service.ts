/**
 * Standalone LLM calls that are not part of the main agent loop. Used for
 * onboarding replies (SoulService), welcome-back message, and memory summarization
 * (MemoryService). The MAIN AGENT uses its own model in AgentService; this service
 * is for one-off prompts (e.g. "generate next onboarding question").
 */
import { Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { UsageService } from '../usage/usage.service';
import { ModelFactoryService } from '../model/model-factory.service';
import { PromptService } from '../prompts/prompt.service';
import { sanitize, extractAndParseJson } from '../utils/input-sanitizer';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private model: ChatOpenAI;

  constructor(
    private readonly usageService: UsageService,
    private readonly modelFactory: ModelFactoryService,
    private readonly promptService: PromptService,
  ) {
    // Use ModelFactory with creative temperature for natural responses
    this.model = this.modelFactory.getModel('creative');
  }


  /**
   * Generate a conversational response for onboarding
   */
  async generateOnboardingResponse(
    step: string,
    userInput: string,
    nextQuestion: string,
    chatId?: string,
  ): Promise<string> {
    try {
      const response = await this.model.invoke([
        new SystemMessage(
          `You are a friendly AI assistant being set up by a new user. Generate a brief, warm response.
          
Rules:
- Keep it short (1-2 sentences max)
- Be friendly but not over the top
- Acknowledge what the user said
- Naturally lead into the next question
- Use simple markdown (*bold* for emphasis)
- No emojis unless it feels natural`,
        ),
        new HumanMessage(
          `The user is setting up their AI assistant.
          
Step: ${step}
User's answer: "${userInput}"
Next question to ask: "${nextQuestion}"

Generate a brief response that acknowledges their answer and asks the next question.`,
        ),
      ]);

      if (AIMessage.isInstance(response)) {
        this.usageService.recordUsageFromResponse(chatId, response);
      }

      return typeof response.content === 'string' ? response.content : String(response.content);
    } catch (error) {
      this.logger.error(`Failed to generate onboarding response: ${error}`);
      // Fallback to simple response
      return `Got it! ${nextQuestion}`;
    }
  }

  /**
   * Generate the final onboarding completion message
   */
  async generateOnboardingComplete(soulData: {
    aiName: string;
    aiCharacter: string;
    aiEmoji: string;
    userName: string;
  }, chatId?: string): Promise<string> {
    try {
      const response = await this.model.invoke([
        new SystemMessage(
          `You are an AI assistant that just finished being set up. Generate a brief, warm completion message.
          
Rules:
- Keep it short (2-3 sentences)
- Introduce yourself with your new name and personality
- Include your signature emoji naturally
- Address the user by their name
- Express readiness to help
- Mention they can update settings later
- Use simple markdown`,
        ),
        new HumanMessage(
          `Setup complete! Generate a completion message with these details:
- AI Name: ${soulData.aiName}
- AI Personality: ${soulData.aiCharacter}
- Signature Emoji: ${soulData.aiEmoji}
- User's Name: ${soulData.userName}`,
        ),
      ]);

      if (AIMessage.isInstance(response)) {
        this.usageService.recordUsageFromResponse(chatId, response);
      }

      return typeof response.content === 'string' ? response.content : String(response.content);
    } catch (error) {
      this.logger.error(`Failed to generate completion message: ${error}`);
      return `${soulData.aiEmoji} Setup complete! I'm *${soulData.aiName}*, ready to help you, ${soulData.userName}!`;
    }
  }

  /**
   * Generate a welcome back message based on AI personality
   */
  async generateWelcomeBack(soulData: {
    aiName: string;
    aiCharacter: string;
    userName: string;
  }, toolCount: number, chatId?: string): Promise<string> {
    try {
      const response = await this.model.invoke([
        new SystemMessage(
          `You are an AI assistant greeting a returning user. Generate a welcome back message.
          
Rules:
- Keep it short (1-2 sentences)
- Match the personality described
- Address the user by name
- Be natural and warm
- Optionally mention you're ready to help
- Use simple markdown (*bold* for emphasis)
- Don't mention tool counts or technical details`,
        ),
        new HumanMessage(
          `Generate a welcome back message with these details:
- AI Name: ${soulData.aiName}
- AI Personality: ${soulData.aiCharacter}
- User's Name: ${soulData.userName}`,
        ),
      ]);

      if (AIMessage.isInstance(response)) {
        this.usageService.recordUsageFromResponse(chatId, response);
      }

      return typeof response.content === 'string' ? response.content : String(response.content);
    } catch (error) {
      this.logger.error(`Failed to generate welcome back message: ${error}`);
      return `Welcome back, *${soulData.userName}*! I'm *${soulData.aiName}*, ready to help.`;
    }
  }

  /**
   * Summarize a conversation to extract important information
   * Returns null/empty string if nothing important to remember
   */
  async summarizeConversation(messages: Array<{ role: string; content: string }>, chatId?: string): Promise<string> {
    if (messages.length === 0) {
      return '';
    }

    try {
      const conversationText = messages
        .map((m) => {
          const roleLabel = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'Summary';
          return `${roleLabel}: ${m.content}`;
        })
        .join('\n\n');

      const response = await this.model.invoke([
        new SystemMessage(
          `You are summarizing a conversation to preserve important context for future interactions.

Rules:
- Extract ONLY important information worth remembering (facts, preferences, decisions, action items)
- If there's nothing significant, return "NOTHING_IMPORTANT"
- Keep the summary concise (2-3 sentences max)
- Focus on: user preferences, important facts mentioned, decisions made, pending tasks
- Do NOT summarize casual chat or greetings
- Write in third person (e.g., "The user mentioned..." or "User asked about...")`,
        ),
        new HumanMessage(
          `Summarize this conversation, keeping only important details worth remembering for future context:

${conversationText}

If there's nothing important, respond with just: NOTHING_IMPORTANT`,
        ),
      ]);

      if (AIMessage.isInstance(response)) {
        this.usageService.recordUsageFromResponse(chatId, response);
      }

      const content = typeof response.content === 'string' ? response.content : String(response.content);

      // Check if the AI determined nothing was important
      if (content.trim() === 'NOTHING_IMPORTANT' || content.trim().toLowerCase().includes('nothing important')) {
        return '';
      }

      return content.trim();
    } catch (error) {
      this.logger.error(`Failed to summarize conversation: ${error}`);
      return '';
    }
  }

  /**
   * Convert user input to a single emoji
   * Handles both direct emoji input and text descriptions
   */
  async convertToEmoji(userInput: string, chatId?: string): Promise<string> {
    // First, check if the input already contains an emoji
    const emojiMatch = userInput.match(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu);
    if (emojiMatch) {
      return emojiMatch[0]; // Return the first emoji found
    }

    // Use AI to convert the description to an emoji
    try {
      const response = await this.model.invoke([
        new SystemMessage(
          `You convert text descriptions into a single emoji. 
          
Rules:
- Return ONLY ONE emoji, nothing else
- No text, no explanation, just the emoji
- Choose the most fitting emoji for the description
- If the description is unclear, pick a friendly default emoji`,
        ),
        new HumanMessage(`Convert this to a single emoji: "${userInput}"`),
      ]);

      if (AIMessage.isInstance(response)) {
        this.usageService.recordUsageFromResponse(chatId, response);
      }

      const content = typeof response.content === 'string' ? response.content : String(response.content);

      // Extract emoji from response
      const resultEmoji = content.trim().match(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu);
      if (resultEmoji) {
        return resultEmoji[0];
      }

      // Fallback to default emoji
      return '🤖';
    } catch (error) {
      this.logger.error(`Failed to convert to emoji: ${error}`);
      return '🤖';
    }
  }

  /**
   * Refine and enhance the soul data before saving
   */
  async refineSoulData(rawData: {
    aiName: string;
    aiCharacter: string;
    userName: string;
    userDescription: string;
    additionalContext: string;
  }, chatId?: string): Promise<{
    aiCharacter: string;
    userDescription: string;
    additionalContext: string;
  }> {
    // Fallback values for safe JSON parsing
    const fallback = {
      aiCharacter: rawData.aiCharacter,
      userDescription: rawData.userDescription,
      additionalContext: rawData.additionalContext,
    };

    try {
      // Get prompt from PromptService or use default
      const systemPromptText = this.promptService.getAiServicePrompt('refineSoulData').system ||
        `You are refining user-provided data for an AI assistant's personality configuration.

Your task is to enhance and clarify the descriptions while keeping the user's intent.

Rules:
- Keep the same meaning, just make it clearer and more useful
- Expand vague descriptions into actionable personality traits
- Format as clear, concise statements
- Don't add things the user didn't mention
- Keep it professional and helpful
- Return ONLY a JSON object with the refined fields`;

      const response = await this.model.invoke([
        new SystemMessage(systemPromptText),
        new HumanMessage(
          `Refine these AI personality settings:

AI Name: ${sanitize(rawData.aiName, 100)}
AI Character (raw): ${sanitize(rawData.aiCharacter, 500)}
User Name: ${sanitize(rawData.userName, 100)}
User Description (raw): ${sanitize(rawData.userDescription, 500)}
Additional Context (raw): ${sanitize(rawData.additionalContext || 'none', 500)}

Return a JSON object with these refined fields:
{
  "aiCharacter": "refined personality description",
  "userDescription": "refined user description",
  "additionalContext": "refined additional context or empty string"
}`,
        ),
      ]);

      if (AIMessage.isInstance(response)) {
        this.usageService.recordUsageFromResponse(chatId, response);
      }

      const content = typeof response.content === 'string' ? response.content : String(response.content);

      // Use safe JSON extraction
      const refined = extractAndParseJson<typeof fallback>(content, fallback);
      return {
        aiCharacter: refined.aiCharacter || rawData.aiCharacter,
        userDescription: refined.userDescription || rawData.userDescription,
        additionalContext: refined.additionalContext || rawData.additionalContext,
      };
    } catch (error) {
      this.logger.error(`Failed to refine soul data: ${error}`);
      return fallback;
    }
  }

  /**
   * Classify whether a message is a coding-related task (clone repo, edit files, git, PR review, etc.).
   * Used by CoderRouterService so routing can be LLM-based instead of keyword heuristic.
   */
  async isCodingTask(message: string, chatId?: string): Promise<boolean> {
    const trimmed = message?.trim();
    if (!trimmed) return false;
    try {
      const response = await this.model.invoke([
        new SystemMessage(
          `You are a classifier. Your only job is to decide if the user message is a CODING-RELATED TASK.

Coding-related means: cloning a git repo, viewing/editing/writing files or code, git operations (commit, push, pull, status), running commands or scripts in a project, reviewing code or a GitHub PR, creating or modifying code files, working with a codebase or repository.

NOT coding-related: general chat, reminders, scheduling, browsing websites (unless to get code), profile updates, asking about the weather, etc.

Reply with exactly one word: YES or NO.`,
        ),
        new HumanMessage(trimmed.slice(0, 2000)),
      ]);
      if (AIMessage.isInstance(response)) {
        this.usageService.recordUsageFromResponse(chatId, response);
      }
      const text = (typeof response.content === 'string' ? response.content : String(response.content))
        .trim()
        .toUpperCase();
      return text.startsWith('YES');
    } catch (error) {
      this.logger.warn(`isCodingTask classification failed: ${error}`);
      return false;
    }
  }
}
