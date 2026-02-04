/**
 * Sends messages and photos to Telegram (e.g. reply to user, send scheduled
 * reminder, send screenshots from browser tasks). Used by TelegramUpdate and
 * SchedulerService. No agent or business logic; pure Telegram API wrapper.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf, Context } from 'telegraf';
import * as fs from 'fs';

@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly logger = new Logger(TelegramService.name);

  constructor(@InjectBot() private readonly bot: Telegraf<Context>) {}

  async onModuleInit() {
    await this.registerCommands();
  }

  /**
   * Register bot commands with Telegram (shows in menu)
   */
  private async registerCommands(): Promise<void> {
    try {
      await this.bot.telegram.setMyCommands([
        { command: 'start', description: 'Start/restart the bot' },
        { command: 'help', description: 'Show help message' },
        { command: 'clear', description: 'Clear conversation history' },
        { command: 'tools', description: 'List available tools' },
        { command: 'profile', description: 'View your profile settings' },
        { command: 'schedules', description: 'View scheduled reminders' },
        { command: 'resetprofile', description: 'Reset and redo onboarding' },
      ]);
      this.logger.log('Bot commands registered successfully');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to register bot commands: ${errorMsg}`);
    }
  }

  /**
   * Send a message to a specific chat
   * Used for scheduled tasks and notifications
   */
  async sendMessage(chatId: string, text: string): Promise<boolean> {
    // Telegram API returns 400 when message text is empty
    const messageText = (text && text.trim()) ? text.trim() : '(No response)';
    try {
      await this.bot.telegram.sendMessage(chatId, messageText, {
        parse_mode: 'Markdown',
      });
      this.logger.log(`Message sent to chat ${chatId}`);
      return true;
    } catch (error) {
      // Try without markdown if it fails
      try {
        await this.bot.telegram.sendMessage(chatId, messageText);
        this.logger.log(`Message sent to chat ${chatId} (plain text fallback)`);
        return true;
      } catch (plainError) {
        const errorMsg = plainError instanceof Error ? plainError.message : String(plainError);
        this.logger.error(`Failed to send message to chat ${chatId}: ${errorMsg}`);
        return false;
      }
    }
  }

  /**
   * Send a photo to a specific chat
   * @param chatId - The chat ID to send to
   * @param photoPath - Path to the photo file
   * @param caption - Optional caption for the photo
   */
  async sendPhoto(chatId: string, photoPath: string, caption?: string): Promise<boolean> {
    try {
      // Check if file exists
      if (!fs.existsSync(photoPath)) {
        this.logger.error(`Photo file not found: ${photoPath}`);
        return false;
      }

      await this.bot.telegram.sendPhoto(
        chatId,
        { source: fs.createReadStream(photoPath) },
        {
          caption,
          parse_mode: 'Markdown',
        },
      );
      this.logger.log(`Photo sent to chat ${chatId}: ${photoPath}`);
      return true;
    } catch (error) {
      // Try without caption markdown if it fails
      try {
        await this.bot.telegram.sendPhoto(
          chatId,
          { source: fs.createReadStream(photoPath) },
          { caption },
        );
        this.logger.log(`Photo sent to chat ${chatId} (plain caption): ${photoPath}`);
        return true;
      } catch (plainError) {
        const errorMsg = plainError instanceof Error ? plainError.message : String(plainError);
        this.logger.error(`Failed to send photo to chat ${chatId}: ${errorMsg}`);
        return false;
      }
    }
  }

  /**
   * Send multiple photos to a specific chat
   * @param chatId - The chat ID to send to
   * @param photoPaths - Array of paths to photo files
   * @param caption - Optional caption for the first photo
   */
  async sendPhotos(chatId: string, photoPaths: string[], caption?: string): Promise<boolean> {
    if (photoPaths.length === 0) {
      return true;
    }

    // For a single photo, use sendPhoto
    if (photoPaths.length === 1) {
      return this.sendPhoto(chatId, photoPaths[0], caption);
    }

    // For multiple photos, send as media group
    try {
      const validPaths = photoPaths.filter(p => fs.existsSync(p));
      if (validPaths.length === 0) {
        this.logger.error('No valid photo files found');
        return false;
      }

      const media = validPaths.map((photoPath, index) => ({
        type: 'photo' as const,
        media: { source: fs.createReadStream(photoPath) },
        caption: index === 0 ? caption : undefined,
        parse_mode: 'Markdown' as const,
      }));

      await this.bot.telegram.sendMediaGroup(chatId, media);
      this.logger.log(`Sent ${validPaths.length} photos to chat ${chatId}`);
      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to send photos to chat ${chatId}: ${errorMsg}`);
      
      // Fallback: try sending one by one
      let success = true;
      for (let i = 0; i < photoPaths.length; i++) {
        const result = await this.sendPhoto(chatId, photoPaths[i], i === 0 ? caption : undefined);
        if (!result) success = false;
      }
      return success;
    }
  }

  /**
   * Send a message with a specific format for scheduled reminders
   */
  async sendScheduledReminder(
    chatId: string,
    description: string,
    taskContext?: string,
  ): Promise<boolean> {
    const message = this.formatReminderMessage(description, taskContext);
    return this.sendMessage(chatId, message);
  }

  /**
   * Format a reminder message with consistent styling
   */
  private formatReminderMessage(description: string, taskContext?: string): string {
    let message = `⏰ *Scheduled Reminder*\n\n${description}`;

    if (taskContext && taskContext.trim()) {
      message += `\n\n_Context:_ ${taskContext}`;
    }

    return message;
  }
}
