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
import { Message } from 'telegraf/types';
import { AgentService } from '../agent/agent.service';
import { AgentLoggerService, LogEvent } from '../logger/agent-logger.service';
import { SoulService } from '../soul/soul.service';
import { ConfigService } from '../config/config.service';
import { SchedulerService } from '../scheduler/scheduler.service';
import { AiService } from '../ai/ai.service';
import { TelegramService } from './telegram.service';
import { MemoryService, FileAttachment } from '../memory/memory.service';
import { ProgressUpdate } from '../messaging/messaging.interface';
import { FileService } from '../file/file.service';
import { FileAnalyzerService } from '../file/file-analyzer.service';
import { formatFileSize, categorizeFile } from '../file/file.types';
import { TranscriptionService } from '../transcription/transcription.service';

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
    private readonly fileService: FileService,
    private readonly fileAnalyzer: FileAnalyzerService,
    private readonly transcriptionService: TranscriptionService,
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

    // Reset memory on /start (extracts important facts first)
    await this.memoryService.resetMemory(chatId);
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
      `To see available commands, call /help`,
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
      `/resetmemory - Clear long-term memories\n` +
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

    await this.agentService.clearConversation(chatId.toString());
    await ctx.reply("🗑️ Conversation history cleared. Let's start fresh!");
  }

  @Command('resetmemory')
  async onResetMemory(@Ctx() ctx: Context) {
    if (!(await this.checkAuthorization(ctx))) {
      return;
    }

    const chatId = ctx.chat?.id?.toString();
    if (!chatId) return;

    this.agentLogger.info(LogEvent.MESSAGE_RECEIVED, 'User requested long-term memory reset', { chatId });

    const longTermService = this.memoryService.getLongTermMemoryService();
    const stats = longTermService.getStats(chatId);

    if (stats.total === 0) {
      await ctx.reply('📭 No long-term memories to clear.');
      return;
    }

    longTermService.clearMemories(chatId);
    await ctx.reply(`🧹 Cleared ${stats.total} long-term memories.\n\n_Your conversation history is preserved. Only stored facts/preferences were removed._`);
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

    // Clear conversation history (extracts important facts first)
    await this.agentService.clearConversation(chatId);

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

    let text = message.text;
    const chatIdStr = chatId.toString();

    // Ignore commands (they're handled by their respective decorators)
    if (text.startsWith('/')) {
      return;
    }

    // Check if this message is a reply to another message - add context
    const replyContext = await this.extractReplyContext(ctx, chatIdStr);
    if (replyContext) {
      text = `[Replying to: ${replyContext}]\n\n${text}`;
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

    // Send initial "Thinking..." message for progress updates
    const initialMsg = await ctx.reply('💭 Thinking...');
    const messageId = initialMsg.message_id;

    // Create progress callback that updates the message
    const onProgress = (update: ProgressUpdate) => {
      // Build progress display with recent updates
      const indicators: Record<string, string> = {
        thinking: '💭',
        tool_start: '⚙️',
        tool_progress: '🔄',
        tool_complete: '✅',
        error: '❌',
      };
      const indicator = indicators[update.type] || '•';
      const progressText = `${indicator} ${update.message}`;

      // Update the message (fire and forget to not block agent)
      this.telegramService.editMessage(chatIdStr, messageId, progressText).catch(() => {
        // Silently ignore edit failures (e.g., rate limits, same content)
      });
    };

    // Keep typing indicator active for long operations
    const typingInterval = setInterval(() => {
      ctx.sendChatAction('typing').catch(() => { });
    }, 4000);

    try {
      const { text: textResponse, screenshots: screenshotPaths } = await this.agentService.processMessage(
        chatIdStr,
        text,
        onProgress,
      );

      clearInterval(typingInterval);

      // Telegram rejects empty messages (400: message text is empty)
      const textToSend = textResponse.trim() || "I didn't generate a response for that. Please try again.";

      // Telegram has a 4096 character limit per message
      if (textToSend.length > 4000) {
        // For long responses, edit initial message with first chunk, then send rest
        const chunks = this.splitMessage(textToSend, 4000);
        // Use fallback=true to ensure first chunk is always delivered
        const editSuccess = await this.telegramService.editMessage(chatIdStr, messageId, chunks[0], true);
        if (!editSuccess) {
          // If edit+fallback both failed, try direct send
          await this.sendWithMarkdown(ctx, chunks[0]);
        }
        for (let i = 1; i < chunks.length; i++) {
          await this.sendWithMarkdown(ctx, chunks[i]);
        }
      } else {
        // Replace progress message with final response (use fallback to ensure delivery)
        const editSuccess = await this.telegramService.editMessage(chatIdStr, messageId, textToSend, true);
        if (!editSuccess) {
          // If edit+fallback both failed, try direct send as last resort
          await this.sendWithMarkdown(ctx, textToSend);
        }
      }

      // Send screenshots from tool artifact (no need to parse marker from text)
      if (screenshotPaths.length > 0) {
        await this.telegramService.sendPhotos(chatIdStr, screenshotPaths, '📸 Screenshot');
      }
    } catch (error) {
      clearInterval(typingInterval);
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error processing message for chat ${chatId}: ${errorMsg}`);

      // Update the progress message with error (use fallback to ensure delivery)
      const errorText = '❌ Sorry, something went wrong. Please try again.';
      const editSuccess = await this.telegramService.editMessage(chatIdStr, messageId, errorText, true);
      if (!editSuccess) {
        await ctx.reply(errorText);
      }
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

  /**
   * Extract context from a reply-to message (if user is replying to a previous message)
   * Returns a summary of what the user is replying to, including file info if applicable
   */
  private async extractReplyContext(ctx: Context, chatId: string): Promise<string | null> {
    const message = ctx.message;
    if (!message || !('reply_to_message' in message) || !message.reply_to_message) {
      return null;
    }

    const replyTo = message.reply_to_message;
    const parts: string[] = [];

    // Check if replying to a text message
    if ('text' in replyTo && replyTo.text) {
      // Truncate long messages
      const text = replyTo.text.length > 200 ? replyTo.text.slice(0, 200) + '...' : replyTo.text;
      parts.push(`message: "${text}"`);
    }

    // Check if replying to a photo
    if ('photo' in replyTo && replyTo.photo && replyTo.photo.length > 0) {
      // Try to find the file in our storage by looking at recent files
      const photo = replyTo.photo[replyTo.photo.length - 1];
      const storedFile = this.fileService.getFileByTelegramId(chatId, photo.file_unique_id);
      
      if (storedFile) {
        parts.push(`photo: "${storedFile.originalName}" (file ID: ${storedFile.id}, path: ${storedFile.localPath})`);
        if (storedFile.memorized && storedFile.tags?.length) {
          parts.push(`tags: ${storedFile.tags.join(', ')}`);
        }
      } else {
        parts.push('a photo (not stored)');
      }

      // Include caption if present
      if ('caption' in replyTo && replyTo.caption) {
        parts.push(`caption: "${replyTo.caption}"`);
      }
    }

    // Check if replying to a document
    if ('document' in replyTo && replyTo.document) {
      const doc = replyTo.document;
      const storedFile = this.fileService.getFileByTelegramId(chatId, doc.file_unique_id);
      
      if (storedFile) {
        parts.push(`document: "${storedFile.originalName}" (file ID: ${storedFile.id}, path: ${storedFile.localPath})`);
      } else {
        parts.push(`document: "${doc.file_name || 'unknown'}" (not stored)`);
      }
    }

    // Check if replying to audio
    if ('audio' in replyTo && replyTo.audio) {
      const audio = replyTo.audio;
      const storedFile = this.fileService.getFileByTelegramId(chatId, audio.file_unique_id);
      
      if (storedFile) {
        parts.push(`audio: "${storedFile.originalName}" (file ID: ${storedFile.id})`);
      } else {
        parts.push(`audio: "${audio.file_name || 'unknown'}" (not stored)`);
      }
    }

    // Check if replying to video
    if ('video' in replyTo && replyTo.video) {
      const video = replyTo.video;
      const storedFile = this.fileService.getFileByTelegramId(chatId, video.file_unique_id);
      
      if (storedFile) {
        parts.push(`video: "${storedFile.originalName}" (file ID: ${storedFile.id})`);
      } else {
        parts.push(`video: "${video.file_name || 'unknown'}" (not stored)`);
      }
    }

    // Check if replying to voice
    if ('voice' in replyTo && replyTo.voice) {
      const voice = replyTo.voice;
      const storedFile = this.fileService.getFileByTelegramId(chatId, voice.file_unique_id);
      
      if (storedFile) {
        parts.push(`voice message (file ID: ${storedFile.id})`);
      } else {
        parts.push('voice message (not stored)');
      }
    }

    if (parts.length === 0) {
      return null;
    }

    return parts.join(', ');
  }

  /**
   * Handle photo messages
   */
  @On('photo')
  async onPhoto(@Ctx() ctx: Context) {
    if (!(await this.checkAuthorization(ctx))) return;

    const chatId = ctx.chat?.id?.toString();
    const message = ctx.message as Message.PhotoMessage;

    if (!chatId || !message?.photo) return;

    // Get the largest photo size
    const photo = message.photo[message.photo.length - 1];
    const caption = message.caption || '';

    await this.handleIncomingFile(ctx, chatId, {
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id,
      fileSize: photo.file_size || 0,
      fileName: `photo_${Date.now()}.jpg`,
      mimeType: 'image/jpeg',
      caption,
    });
  }

  /**
   * Handle document messages
   */
  @On('document')
  async onDocument(@Ctx() ctx: Context) {
    if (!(await this.checkAuthorization(ctx))) return;

    const chatId = ctx.chat?.id?.toString();
    const message = ctx.message as Message.DocumentMessage;

    if (!chatId || !message?.document) return;

    const doc = message.document;
    const caption = message.caption || '';

    await this.handleIncomingFile(ctx, chatId, {
      fileId: doc.file_id,
      fileUniqueId: doc.file_unique_id,
      fileSize: doc.file_size || 0,
      fileName: doc.file_name || `document_${Date.now()}`,
      mimeType: doc.mime_type || 'application/octet-stream',
      caption,
    });
  }

  /**
   * Handle audio messages
   */
  @On('audio')
  async onAudio(@Ctx() ctx: Context) {
    if (!(await this.checkAuthorization(ctx))) return;

    const chatId = ctx.chat?.id?.toString();
    const message = ctx.message as Message.AudioMessage;

    if (!chatId || !message?.audio) return;

    const audio = message.audio;
    const caption = message.caption || '';

    await this.handleIncomingFile(ctx, chatId, {
      fileId: audio.file_id,
      fileUniqueId: audio.file_unique_id,
      fileSize: audio.file_size || 0,
      fileName: audio.file_name || `audio_${Date.now()}.mp3`,
      mimeType: audio.mime_type || 'audio/mpeg',
      caption,
    });
  }

  /**
   * Handle video messages
   */
  @On('video')
  async onVideo(@Ctx() ctx: Context) {
    if (!(await this.checkAuthorization(ctx))) return;

    const chatId = ctx.chat?.id?.toString();
    const message = ctx.message as Message.VideoMessage;

    if (!chatId || !message?.video) return;

    const video = message.video;
    const caption = message.caption || '';

    await this.handleIncomingFile(ctx, chatId, {
      fileId: video.file_id,
      fileUniqueId: video.file_unique_id,
      fileSize: video.file_size || 0,
      fileName: video.file_name || `video_${Date.now()}.mp4`,
      mimeType: video.mime_type || 'video/mp4',
      caption,
    });
  }

  /**
   * Handle voice messages - transcribe and act upon them
   * By default: transcribes the voice message and passes to the AI agent for action
   * If user previously asked "transcribe this", just returns the transcription
   */
  @On('voice')
  async onVoice(@Ctx() ctx: Context) {
    if (!(await this.checkAuthorization(ctx))) return;

    const chatId = ctx.chat?.id?.toString();
    const message = ctx.message as Message.VoiceMessage;

    if (!chatId || !message?.voice) return;

    // Check if user has completed onboarding
    if (!this.soulService.hasCompletedOnboarding(chatId)) {
      await ctx.reply('Please complete the setup first by sending /start');
      return;
    }

    // Check if transcription service is available
    if (!this.transcriptionService.isAvailable()) {
      await ctx.reply('Voice transcription is not available. Please configure GROQ_API_KEY.');
      return;
    }

    const voice = message.voice;

    // Show typing indicator
    await ctx.sendChatAction('typing');

    try {
      // Get file URL from Telegram
      const fileLink = await ctx.telegram.getFileLink(voice.file_id);
      const fileUrl = fileLink.href;

      // Download voice file temporarily
      const tempPath = await this.downloadVoiceFile(chatId, fileUrl, voice.file_id);

      // Transcribe the voice message
      const transcription = await this.transcriptionService.transcribe(tempPath);

      // Clean up temp file
      this.cleanupTempFile(tempPath);

      if (!transcription.text || transcription.text.trim() === '') {
        await ctx.reply("I couldn't understand the audio. Please try speaking more clearly.");
        return;
      }

      // Check if user wants transcription only (check recent messages for intent)
      const wantsTranscriptionOnly = await this.checkTranscriptionOnlyIntent(chatId);

      if (wantsTranscriptionOnly) {
        // Just return the transcription
        const response = `*Transcription:*\n\n${transcription.text}`;
        await this.sendWithMarkdown(ctx, response);

        // Record in memory
        await this.memoryService.addMessage(chatId, 'user', '[User sent a voice message asking for transcription]');
        await this.memoryService.addMessage(chatId, 'assistant', response);
        return;
      }

      // Default behavior: treat transcribed text as user input and process with agent
      this.agentLogger.info(LogEvent.MESSAGE_RECEIVED, `Voice message transcribed: ${transcription.text.slice(0, 100)}...`, { chatId });

      // Send initial "Thinking..." message for progress updates
      const initialMsg = await ctx.reply(`*Voice transcribed:* "${transcription.text.slice(0, 100)}${transcription.text.length > 100 ? '...' : ''}"\n\n💭 Processing...`);
      const messageId = initialMsg.message_id;

      // Create progress callback that updates the message
      const onProgress = (update: ProgressUpdate) => {
        const indicators: Record<string, string> = {
          thinking: '💭',
          tool_start: '⚙️',
          tool_progress: '🔄',
          tool_complete: '✅',
          error: '❌',
        };
        const indicator = indicators[update.type] || '•';
        const progressText = `*Voice:* "${transcription.text.slice(0, 50)}..."\n\n${indicator} ${update.message}`;

        this.telegramService.editMessage(chatId, messageId, progressText).catch(() => {});
      };

      // Keep typing indicator active for long operations
      const typingInterval = setInterval(() => {
        ctx.sendChatAction('typing').catch(() => {});
      }, 4000);

      try {
        const { text: textResponse, screenshots: screenshotPaths } = await this.agentService.processMessage(
          chatId,
          `[Voice message transcription]: ${transcription.text}`,
          onProgress,
        );

        clearInterval(typingInterval);

        const textToSend = textResponse.trim() || "I didn't generate a response for that. Please try again.";

        if (textToSend.length > 4000) {
          const chunks = this.splitMessage(textToSend, 4000);
          const editSuccess = await this.telegramService.editMessage(chatId, messageId, chunks[0], true);
          if (!editSuccess) {
            await this.sendWithMarkdown(ctx, chunks[0]);
          }
          for (let i = 1; i < chunks.length; i++) {
            await this.sendWithMarkdown(ctx, chunks[i]);
          }
        } else {
          const editSuccess = await this.telegramService.editMessage(chatId, messageId, textToSend, true);
          if (!editSuccess) {
            await this.sendWithMarkdown(ctx, textToSend);
          }
        }

        if (screenshotPaths.length > 0) {
          await this.telegramService.sendPhotos(chatId, screenshotPaths, '📸 Screenshot');
        }
      } catch (error) {
        clearInterval(typingInterval);
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Error processing voice message for chat ${chatId}: ${errorMsg}`);
        const errorText = '❌ Sorry, something went wrong processing your voice message.';
        const editSuccess = await this.telegramService.editMessage(chatId, messageId, errorText, true);
        if (!editSuccess) {
          await ctx.reply(errorText);
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to transcribe voice message for ${chatId}: ${errorMsg}`);
      await ctx.reply(`Sorry, I couldn't transcribe your voice message: ${errorMsg}`);
    }
  }

  /**
   * Download voice file to a temporary location
   */
  private async downloadVoiceFile(chatId: string, url: string, fileId: string): Promise<string> {
    const fs = await import('fs');
    const path = await import('path');
    const https = await import('https');
    const http = await import('http');

    const tempDir = path.join(process.cwd(), 'data', chatId, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const tempPath = path.join(tempDir, `voice_${fileId}.ogg`);

    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;
      const file = fs.createWriteStream(tempPath);

      protocol.get(url, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            file.close();
            fs.unlinkSync(tempPath);
            this.downloadVoiceFile(chatId, redirectUrl, fileId).then(resolve).catch(reject);
            return;
          }
        }

        if (response.statusCode !== 200) {
          file.close();
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
          reject(new Error(`Download failed with status ${response.statusCode}`));
          return;
        }

        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve(tempPath);
        });
      }).on('error', (err) => {
        file.close();
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        reject(err);
      });
    });
  }

  /**
   * Clean up temporary voice file
   */
  private cleanupTempFile(filePath: string): void {
    try {
      const fs = require('fs');
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      this.logger.warn(`Failed to cleanup temp file ${filePath}: ${error}`);
    }
  }

  /**
   * Check if the user's recent messages indicate they want transcription only
   * (e.g., "transcribe this", "just transcribe", "transcription only")
   */
  private async checkTranscriptionOnlyIntent(chatId: string): Promise<boolean> {
    const recentMessages = this.memoryService.getMessages(chatId);
    if (recentMessages.length === 0) return false;

    // Check the last few user messages for transcription-only intent
    const lastMessages = recentMessages.slice(-3);
    const transcriptionKeywords = [
      'transcribe this',
      'just transcribe',
      'transcription only',
      'transcribe it',
      'transcribe the next',
      'only transcribe',
      'transcribe for me',
    ];

    for (const msg of lastMessages) {
      if (msg.role === 'user') {
        const lowerContent = msg.content.toLowerCase();
        if (transcriptionKeywords.some(keyword => lowerContent.includes(keyword))) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Common handler for all incoming files
   */
  private async handleIncomingFile(
    ctx: Context,
    chatId: string,
    fileInfo: {
      fileId: string;
      fileUniqueId: string;
      fileSize: number;
      fileName: string;
      mimeType: string;
      caption: string;
    },
  ) {
    const { fileId, fileUniqueId, fileSize, fileName, mimeType, caption } = fileInfo;

    // Check if user has completed onboarding
    if (!this.soulService.hasCompletedOnboarding(chatId)) {
      await ctx.reply('Please complete the setup first by sending /start');
      return;
    }

    // Check if file already exists
    const existing = this.fileService.getFileByTelegramId(chatId, fileUniqueId);
    if (existing) {
      const duplicateMessage = `I already have this file stored as "${existing.originalName}".`;
      // Record both the user's attempt and our response
      const userMessage = caption.trim()
        ? `[User sent a file: "${fileName}" (duplicate)] ${caption}`
        : `[User sent a file: "${fileName}" (duplicate)]`;
      await this.memoryService.addMessage(chatId, 'user', userMessage);
      await this.memoryService.addMessage(chatId, 'assistant', duplicateMessage);
      await ctx.reply(duplicateMessage);
      return;
    }

    // Check storage limits
    const limitsCheck = this.fileService.checkStorageLimits(chatId, fileSize);
    if (!limitsCheck.allowed) {
      const limitMessage = limitsCheck.message || 'Storage limit reached.';
      // Record the attempt and error
      const userMessage = caption.trim()
        ? `[User sent a file: "${fileName}" (rejected - storage limit)] ${caption}`
        : `[User sent a file: "${fileName}" (rejected - storage limit)]`;
      await this.memoryService.addMessage(chatId, 'user', userMessage);
      await this.memoryService.addMessage(chatId, 'assistant', limitMessage);
      await ctx.reply(limitMessage);
      return;
    }

    // Check MIME type
    if (!this.fileService.isAllowedMimeType(mimeType)) {
      const typeMessage = `Sorry, I can't store ${mimeType} files. Supported: images, documents, audio, video.`;
      // Record the attempt and error
      const userMessage = caption.trim()
        ? `[User sent a file: "${fileName}" (rejected - unsupported type)] ${caption}`
        : `[User sent a file: "${fileName}" (rejected - unsupported type)]`;
      await this.memoryService.addMessage(chatId, 'user', userMessage);
      await this.memoryService.addMessage(chatId, 'assistant', typeMessage);
      await ctx.reply(typeMessage);
      return;
    }

    // Show processing indicator
    await ctx.sendChatAction('upload_document');

    try {
      // Get file URL from Telegram
      const fileLink = await ctx.telegram.getFileLink(fileId);
      const fileUrl = fileLink.href;

      // Download and store
      const metadata = await this.fileService.downloadAndStore(
        chatId,
        fileId,
        fileUniqueId,
        fileUrl,
        fileName,
        mimeType,
        fileSize,
        caption,
        ctx.message?.message_id,
      );

      const category = categorizeFile(mimeType);
      const sizeStr = formatFileSize(metadata.size);

      // Create file attachment metadata for memory
      const fileAttachment: FileAttachment = {
        fileId: metadata.id,
        fileName: metadata.originalName,
        filePath: metadata.localPath,
        mimeType: metadata.mimeType,
        size: metadata.size,
      };

      // If there's a caption, let agentService.processMessage handle memory recording
      // to avoid duplicate user messages. Otherwise record here.
      if (caption.trim()) {
        // Show brief acknowledgment while processing
        const processingMessage = `📁 File received: ${metadata.originalName}\nProcessing your message with the file...`;
        await this.sendWithMarkdown(ctx, processingMessage);

        // Don't record to memory here - processMessageWithFile -> agentService will handle it
        // Process caption with file context (this will add messages to memory via agentService)
        await this.processMessageWithFile(ctx, chatId, caption, metadata.id, metadata.localPath, mimeType);
      } else {
        // No caption - record user file upload and ask what to do
        const userFileMessage = `[User sent a ${category} file: "${metadata.originalName}" (${sizeStr})]`;
        await this.memoryService.addMessage(chatId, 'user', userFileMessage, [fileAttachment]);

        // Build acknowledgment message
        let ackMessage = `📁 File received!\n\n`;
        ackMessage += `Name: ${metadata.originalName}\n`;
        ackMessage += `Type: ${category}\n`;
        ackMessage += `Size: ${sizeStr}\n`;
        ackMessage += `\nWhat would you like me to do with this file?\n`;
        ackMessage += `• "Analyze it" - Use AI to understand the content\n`;
        ackMessage += `• "Memorize it as [description]" - Save for later reference\n`;
        ackMessage += `• Or just tell me what you need!\n`;
        ackMessage += `\nFile ID: ${metadata.id}`;

        await this.sendWithMarkdown(ctx, ackMessage);

        // Record the acknowledgment in memory
        await this.memoryService.addMessage(chatId, 'assistant', ackMessage);
      }

      this.agentLogger.info(LogEvent.MESSAGE_RECEIVED, `File stored: ${fileName}`, { chatId });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to store file for ${chatId}: ${errorMsg}`);
      const errorResponse = `Sorry, I couldn't store that file: ${errorMsg}`;
      // Record the failed attempt in memory (still record file info for context)
      const userMessage = caption.trim()
        ? `[User sent a file: "${fileName}" (storage failed)] ${caption}`
        : `[User sent a file: "${fileName}" (storage failed)]`;
      await this.memoryService.addMessage(chatId, 'user', userMessage);
      await this.memoryService.addMessage(chatId, 'assistant', errorResponse);
      await ctx.reply(errorResponse);
    }
  }

  /**
   * Process a message that includes a file (for multi-modal support)
   */
  private async processMessageWithFile(
    ctx: Context,
    chatId: string,
    userMessage: string,
    fileId: string,
    _localPath: string, // Using fileService.getFilePath() instead
    mimeType: string,
  ) {
    // Send initial "Thinking..." message for progress updates
    const initialMsg = await ctx.reply('💭 Analyzing...');
    const messageId = initialMsg.message_id;

    // Create progress callback
    const onProgress = (update: ProgressUpdate) => {
      const indicators: Record<string, string> = {
        thinking: '💭',
        tool_start: '⚙️',
        tool_progress: '🔄',
        tool_complete: '✅',
        error: '❌',
      };
      const indicator = indicators[update.type] || '•';
      const progressText = `${indicator} ${update.message}`;

      this.telegramService.editMessage(chatId, messageId, progressText).catch(() => { });
    };

    // Keep typing indicator active
    const typingInterval = setInterval(() => {
      ctx.sendChatAction('typing').catch(() => { });
    }, 4000);

    try {
      // Build attached files array for multi-modal processing
      const filePath = this.fileService.getFilePath(chatId, fileId);
      const attachedFiles = filePath
        ? [{ id: fileId, path: filePath, mimeType }]
        : [];

      const { text: textResponse, screenshots } = await this.agentService.processMessage(
        chatId,
        userMessage,
        onProgress,
        attachedFiles,
      );

      clearInterval(typingInterval);

      const textToSend = textResponse.trim() || "I've processed your file.";

      if (textToSend.length > 4000) {
        const chunks = this.splitMessage(textToSend, 4000);
        // Use fallback=true to ensure first chunk is always delivered
        const editSuccess = await this.telegramService.editMessage(chatId, messageId, chunks[0], true);
        if (!editSuccess) {
          await this.sendWithMarkdown(ctx, chunks[0]);
        }
        for (let i = 1; i < chunks.length; i++) {
          await this.sendWithMarkdown(ctx, chunks[i]);
        }
      } else {
        // Use fallback=true to ensure response is always delivered
        const editSuccess = await this.telegramService.editMessage(chatId, messageId, textToSend, true);
        if (!editSuccess) {
          await this.sendWithMarkdown(ctx, textToSend);
        }
      }

      if (screenshots.length > 0) {
        await this.telegramService.sendPhotos(chatId, screenshots, '📸 Screenshot');
      }
    } catch (error) {
      clearInterval(typingInterval);
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error processing file message for ${chatId}: ${errorMsg}`);
      // Use fallback to ensure error message is delivered
      const errorText = '❌ Sorry, something went wrong.';
      const editSuccess = await this.telegramService.editMessage(chatId, messageId, errorText, true);
      if (!editSuccess) {
        await ctx.reply(errorText);
      }
    }
  }
}
