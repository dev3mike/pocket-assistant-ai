/**
 * ENTRY POINT for user messages over Telegram. Handles /start, /help, /clear,
 * /tools, /profile, /schedules, and text messages. For text: checks onboarding
 * (SoulService), then calls the MAIN AGENT (AgentService.processMessage), then
 * sends the reply and any screenshots back to the user. Does not run an agent;
 * it only receives input and sends output.
 */
import { Logger } from '@nestjs/common';
import { Update, Ctx, Start, Help, On, Command } from 'nestjs-telegraf';
import { Context } from 'telegraf';
import { AgentService } from '../agent/agent.service';
import { AgentLoggerService, LogEvent } from '../logger/agent-logger.service';
import { SoulService } from '../soul/soul.service';
import { ConfigService } from '../config/config.service';
import { SchedulerService } from '../scheduler/scheduler.service';
import { AiService } from '../ai/ai.service';
import { TelegramService } from './telegram.service';
import { MemoryService } from '../memory/memory.service';

const UNAUTHORIZED_MESSAGE = `🚫 *Access Denied*

You are not authorized to use this bot.

To request access, please contact the bot owner and provide your User ID:

\`{USER_ID}\`

_Copy this ID and send it to the owner to be added to the allowed list._`;

@Update()
export class TelegramUpdate {
  private readonly logger = new Logger(TelegramUpdate.name);

  constructor(
    private readonly agentService: AgentService,
    private readonly agentLogger: AgentLoggerService,
    private readonly soulService: SoulService,
    private readonly configService: ConfigService,
    private readonly schedulerService: SchedulerService,
    private readonly aiService: AiService,
    private readonly telegramService: TelegramService,
    private readonly memoryService: MemoryService,
  ) { }

  /**
   * Check if user is authorized to use the bot
   * Returns true if authorized, false if not (and sends unauthorized message)
   */
  private async checkAuthorization(ctx: Context): Promise<boolean> {
    const userId = ctx.from?.id?.toString();

    if (!userId) {
      return false;
    }

    if (!this.configService.isUserAllowed(userId)) {
      this.logger.warn(`Unauthorized access attempt from user ${userId}`);
      const message = UNAUTHORIZED_MESSAGE.replace('{USER_ID}', userId);
      await this.sendWithMarkdown(ctx, message);
      return false;
    }

    return true;
  }

  @Start()
  async onStart(@Ctx() ctx: Context) {
    // Security check first
    if (!(await this.checkAuthorization(ctx))) {
      return;
    }

    const chatId = ctx.chat?.id?.toString();
    if (!chatId) return;

    this.agentLogger.info(LogEvent.MESSAGE_RECEIVED, 'User started the bot', { chatId });

    // Reset memory on /start
    this.memoryService.resetMemory(chatId);
    this.agentLogger.info(LogEvent.CONVERSATION_CLEARED, 'Memory reset on /start', { chatId });

    // Check if user has completed onboarding
    if (!this.soulService.hasCompletedOnboarding(chatId)) {
      // Start onboarding (show typing while AI generates response)
      await ctx.sendChatAction('typing');
      const message = await this.soulService.startOnboarding(chatId);
      await this.sendWithMarkdown(ctx, message);
      return;
    }

    // User already onboarded - show welcome back message
    const soul = this.soulService.getSoulData(chatId);

    if (!soul) {
      // Shouldn't happen, but handle gracefully
      await ctx.sendChatAction('typing');
      const message = await this.soulService.startOnboarding(chatId);
      await this.sendWithMarkdown(ctx, message);
      return;
    }

    // Generate AI welcome message based on personality
    await ctx.sendChatAction('typing');
    const tools = this.agentService.getAvailableTools();
    const welcomeMessage = await this.aiService.generateWelcomeBack(
      {
        aiName: soul.aiName,
        aiCharacter: soul.aiCharacter,
        userName: soul.userName,
      },
      tools.length,
      chatId,
    );

    await this.sendWithMarkdown(
      ctx,
      `${welcomeMessage}\n\n` +
      `Commands:\n` +
      `/help - Show available commands\n` +
      `/clear - Clear conversation history\n` +
      `/tools - List available tools\n` +
      `/profile - View/update your profile\n` +
      `/schedules - View scheduled reminders`,
    );
  }

  @Help()
  async onHelp(@Ctx() ctx: Context) {
    if (!(await this.checkAuthorization(ctx))) {
      return;
    }

    const chatId = ctx.chat?.id?.toString() ?? 'unknown';
    this.agentLogger.info(LogEvent.MESSAGE_RECEIVED, 'User requested help', { chatId });

    const soul = this.soulService.getSoulData(chatId);
    const aiName = soul?.aiName || 'AI Assistant';

    await this.sendWithMarkdown(
      ctx,
      `🤖 *${aiName} Help*\n\n` +
      `Just send me any message and I'll respond using AI.\n\n` +
      `*Available Commands:*\n` +
      `/start - Start/restart the bot\n` +
      `/help - Show this help message\n` +
      `/clear - Clear conversation history\n` +
      `/tools - List available tools\n` +
      `/profile - View your profile settings\n` +
      `/schedules - View scheduled reminders\n` +
      `/resetprofile - Reset and redo onboarding\n\n` +
      `*Features:*\n` +
      `• I remember our conversation context\n` +
      `• I can use tools to help you\n` +
      `• Say "update my profile" to change settings\n` +
      `• Say "remind me..." to set reminders`,
    );
  }

  @Command('clear')
  async onClear(@Ctx() ctx: Context) {
    if (!(await this.checkAuthorization(ctx))) {
      return;
    }

    const chatId = ctx.chat?.id;
    if (!chatId) return;

    this.agentService.clearConversation(chatId.toString());
    await ctx.reply("🗑️ Conversation history cleared. Let's start fresh!");
  }

  @Command('tools')
  async onTools(@Ctx() ctx: Context) {
    if (!(await this.checkAuthorization(ctx))) {
      return;
    }

    const chatId = ctx.chat?.id?.toString() ?? 'unknown';
    this.agentLogger.info(LogEvent.MESSAGE_RECEIVED, 'User requested tools list', { chatId });

    const tools = this.agentService.getAvailableTools();

    if (tools.length === 0) {
      await ctx.reply('No tools are currently available.');
      return;
    }

    await this.sendWithMarkdown(
      ctx,
      `🛠️ *Available Tools (${tools.length}):*\n\n` + tools.map((t) => `• \`${t}\``).join('\n'),
    );
  }

  @Command('profile')
  async onProfile(@Ctx() ctx: Context) {
    if (!(await this.checkAuthorization(ctx))) {
      return;
    }

    const chatId = ctx.chat?.id?.toString();
    if (!chatId) return;

    const soul = this.soulService.getSoulData(chatId);

    if (!soul) {
      await this.sendWithMarkdown(ctx, "You haven't set up your profile yet. Use /start to begin.");
      return;
    }

    await this.sendWithMarkdown(
      ctx,
      `👤 *Your Profile*\n\n` +
      `*AI Name:* ${soul.aiName}\n` +
      `*AI Personality:* ${soul.aiCharacter}\n` +
      `*Signature Emoji:* ${soul.aiEmoji || '🤖'}\n` +
      `*Your Name:* ${soul.userName}\n` +
      `*About You:* ${soul.userDescription}\n` +
      `*Additional Context:* ${soul.additionalContext || 'None'}\n\n` +
      `_Use /resetprofile to reset and redo onboarding._`,
    );
  }

  @Command('resetprofile')
  async onResetProfile(@Ctx() ctx: Context) {
    if (!(await this.checkAuthorization(ctx))) {
      return;
    }

    const chatId = ctx.chat?.id?.toString();
    if (!chatId) return;

    // Delete existing soul data
    this.soulService.deleteSoulData(chatId);

    // Clear conversation history
    this.agentService.clearConversation(chatId);

    // Cancel any ongoing onboarding
    this.soulService.cancelOnboarding(chatId);

    this.agentLogger.info(LogEvent.CONVERSATION_CLEARED, 'Profile reset via /resetprofile', { chatId });

    // Start fresh onboarding
    await ctx.sendChatAction('typing');
    const message = await this.soulService.startOnboarding(chatId);
    await this.sendWithMarkdown(ctx, message);
  }

  @Command('schedules')
  async onSchedules(@Ctx() ctx: Context) {
    if (!(await this.checkAuthorization(ctx))) {
      return;
    }

    const chatId = ctx.chat?.id?.toString();
    if (!chatId) return;

    this.agentLogger.info(LogEvent.MESSAGE_RECEIVED, 'User requested schedules list', { chatId });

    const jobs = this.schedulerService.getActiveJobsForChat(chatId);

    if (jobs.length === 0) {
      await this.sendWithMarkdown(ctx, '📋 You have no active scheduled tasks.\n\n_Tell me something like "remind me to call mom tomorrow at 5pm" to create one._');
      return;
    }

    const jobsList = jobs.map((job) => this.schedulerService.formatJobForDisplay(job)).join('\n\n---\n\n');
    await this.sendWithMarkdown(ctx, `📋 *Your Active Schedules (${jobs.length}):*\n\n${jobsList}`);
  }

  @On('text')
  async onMessage(@Ctx() ctx: Context) {
    // Security check first
    if (!(await this.checkAuthorization(ctx))) {
      return;
    }

    const chatId = ctx.chat?.id;
    const message = ctx.message;

    if (!chatId || !message || !('text' in message)) {
      return;
    }

    const text = message.text;
    const chatIdStr = chatId.toString();

    // Ignore commands (they're handled by their respective decorators)
    if (text.startsWith('/')) {
      return;
    }

    // Check if user is in onboarding flow
    if (this.soulService.isOnboarding(chatIdStr)) {
      await ctx.sendChatAction('typing');
      const result = await this.soulService.processOnboardingResponse(chatIdStr, text);
      await this.sendWithMarkdown(ctx, result.message);
      return;
    }

    // Check if user hasn't completed onboarding at all
    if (!this.soulService.hasCompletedOnboarding(chatIdStr)) {
      await ctx.sendChatAction('typing');
      const onboardingMessage = await this.soulService.startOnboarding(chatIdStr);
      await this.sendWithMarkdown(ctx, onboardingMessage);
      return;
    }

    // Show typing indicator
    await ctx.sendChatAction('typing');

    // Keep typing indicator active for long operations
    const typingInterval = setInterval(() => {
      ctx.sendChatAction('typing').catch(() => { });
    }, 4000);

    try {
      const { text: textResponse, screenshots: screenshotPaths } = await this.agentService.processMessage(chatIdStr, text);

      clearInterval(typingInterval);

      // Telegram rejects empty messages (400: message text is empty)
      const textToSend = textResponse.trim() || "I didn't generate a response for that. Please try again.";
      // Telegram has a 4096 character limit per message
      if (textToSend.length > 4000) {
        const chunks = this.splitMessage(textToSend, 4000);
        for (const chunk of chunks) {
          await this.sendWithMarkdown(ctx, chunk);
        }
      } else {
        await this.sendWithMarkdown(ctx, textToSend);
      }

      // Send screenshots from tool artifact (no need to parse marker from text)
      if (screenshotPaths.length > 0) {
        await this.telegramService.sendPhotos(chatIdStr, screenshotPaths, '📸 Screenshot');
      }
    } catch (error) {
      clearInterval(typingInterval);
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error processing message for chat ${chatId}: ${errorMsg}`);
      await ctx.reply('❌ Sorry, something went wrong. Please try again.');
    }
  }

  /**
   * Try to send message with Markdown parsing, fall back to plain text if it fails
   */
  private async sendWithMarkdown(ctx: Context, text: string): Promise<void> {
    const safeText = text.trim() || '(No content)';
    // Convert standard markdown to Telegram-compatible markdown
    const telegramText = this.convertToTelegramMarkdown(safeText);

    try {
      await ctx.reply(telegramText, { parse_mode: 'Markdown' });
    } catch {
      // If markdown parsing fails, try plain text (strip markdown)
      try {
        const plainText = this.stripMarkdown(safeText);
        await ctx.reply(plainText);
      } catch (plainError) {
        this.logger.error(`Failed to send message: ${plainError}`);
        throw plainError;
      }
    }
  }

  /**
   * Convert standard markdown to Telegram-compatible markdown
   * Telegram uses: *bold*, _italic_, `code`, ```pre```
   * Standard uses: **bold**, *italic*, `code`, ```pre```
   */
  private convertToTelegramMarkdown(text: string): string {
    // Convert **bold** to *bold* (standard markdown bold to telegram bold)
    // Be careful not to affect already-single asterisks
    let converted = text.replace(/\*\*([^*]+)\*\*/g, '*$1*');

    // Convert __underline__ to _italic_ (telegram doesn't have underline, use italic)
    converted = converted.replace(/__([^_]+)__/g, '_$1_');

    return converted;
  }

  /**
   * Strip markdown formatting for plain text fallback
   */
  private stripMarkdown(text: string): string {
    return text
      .replace(/\*\*([^*]+)\*\*/g, '$1')  // Remove **bold**
      .replace(/\*([^*]+)\*/g, '$1')       // Remove *italic* or *bold*
      .replace(/_([^_]+)_/g, '$1')         // Remove _italic_
      .replace(/`([^`]+)`/g, '$1')         // Remove `code`
      .replace(/```[\s\S]*?```/g, (match) => match.replace(/```/g, '')); // Remove code block markers
  }

  private splitMessage(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      let splitIndex = remaining.lastIndexOf('\n', maxLength);
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        splitIndex = remaining.lastIndexOf(' ', maxLength);
      }
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        splitIndex = maxLength;
      }

      chunks.push(remaining.slice(0, splitIndex));
      remaining = remaining.slice(splitIndex).trimStart();
    }

    return chunks;
  }
}
