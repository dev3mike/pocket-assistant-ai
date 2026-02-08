/**
 * Sends messages and photos to Telegram (e.g. reply to user, send scheduled
 * reminder, send screenshots from browser tasks). Used by TelegramUpdate and
 * SchedulerService. No agent or business logic; pure Telegram API wrapper.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf, Context } from 'telegraf';
import * as fs from 'fs';

// Rate limiting for message edits (Telegram limits ~30 edits/minute per message)
const EDIT_MIN_INTERVAL_MS = 2000; // Min 2 seconds between edits
const EDIT_MAX_RETRIES = 2;

@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly logger = new Logger(TelegramService.name);
  // Track last edit time per message to enforce rate limiting
  private readonly lastEditTime = new Map<string, number>();

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
   * @returns Message ID if successful, null otherwise
   */
  async sendMessage(chatId: string, text: string): Promise<number | null> {
    // Telegram API returns 400 when message text is empty
    const messageText = (text && text.trim()) ? text.trim() : '(No response)';
    try {
      const result = await this.bot.telegram.sendMessage(chatId, messageText, {
        parse_mode: 'Markdown',
      });
      this.logger.log(`Message sent to chat ${chatId} (id: ${result.message_id})`);
      return result.message_id;
    } catch (error) {
      // Try without markdown if it fails
      try {
        const result = await this.bot.telegram.sendMessage(chatId, messageText);
        this.logger.log(`Message sent to chat ${chatId} (plain text fallback, id: ${result.message_id})`);
        return result.message_id;
      } catch (plainError) {
        const errorMsg = plainError instanceof Error ? plainError.message : String(plainError);
        this.logger.error(`Failed to send message to chat ${chatId}: ${errorMsg}`);
        return null;
      }
    }
  }

  /**
   * Delete a message from a chat
   * @param chatId - The chat ID
   * @param messageId - The message ID to delete
   * @returns true if successful, false otherwise
   */
  async deleteMessage(chatId: string, messageId: number): Promise<boolean> {
    try {
      await this.bot.telegram.deleteMessage(chatId, messageId);
      this.logger.debug(`Message ${messageId} deleted from chat ${chatId}`);
      return true;
    } catch (error) {
      // Silently fail - message might already be deleted or too old
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.debug(`Failed to delete message ${messageId} from chat ${chatId}: ${errorMsg}`);
      return false;
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
    const result = await this.sendMessage(chatId, message);
    return result !== null;
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

  /**
   * Edit an existing message with rate limiting.
   * Falls back to sending a new message if edit fails or is rate-limited.
   * @param chatId - The chat ID
   * @param messageId - The message ID to edit
   * @param text - The new message text
   * @param fallbackToNew - If true, send a new message when edit fails (default: false)
   * @returns Object with success status and optionally new message ID if fallback was used
   */
  async editMessage(
    chatId: string,
    messageId: number,
    text: string,
    fallbackToNew = false,
  ): Promise<boolean> {
    // Telegram API returns 400 when message text is empty
    const messageText = text && text.trim() ? text.trim() : '(No response)';
    const editKey = `${chatId}:${messageId}`;

    // Rate limiting: check if we're editing too fast
    const lastEdit = this.lastEditTime.get(editKey) ?? 0;
    const now = Date.now();
    const timeSinceLastEdit = now - lastEdit;

    if (timeSinceLastEdit < EDIT_MIN_INTERVAL_MS) {
      // Too soon to edit - if fallback enabled, send new message instead
      if (fallbackToNew) {
        this.logger.debug(`Edit rate limited, sending new message instead`);
        const result = await this.sendMessage(chatId, messageText);
        return result !== null;
      }
      // Otherwise return false so caller knows the edit was skipped
      // This allows caller to decide whether to fallback
      this.logger.debug(`Edit rate limited for message ${messageId}, skipping`);
      return false;
    }

    // Update last edit time
    this.lastEditTime.set(editKey, now);

    // Clean up old entries periodically (keep map from growing indefinitely)
    if (this.lastEditTime.size > 1000) {
      const cutoff = now - 60000; // Remove entries older than 1 minute
      for (const [key, time] of this.lastEditTime.entries()) {
        if (time < cutoff) this.lastEditTime.delete(key);
      }
    }

    let retries = 0;
    while (retries <= EDIT_MAX_RETRIES) {
      try {
        await this.bot.telegram.editMessageText(chatId, messageId, undefined, messageText, {
          parse_mode: 'Markdown',
        });
        this.logger.debug(`Message ${messageId} edited in chat ${chatId}`);
        return true;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);

        // If message not modified (same content), that's fine
        if (errorMsg.includes('message is not modified')) {
          return true;
        }

        // If rate limited by Telegram (429), wait and retry
        if (errorMsg.includes('Too Many Requests') || errorMsg.includes('429')) {
          retries++;
          const waitMatch = errorMsg.match(/retry after (\d+)/i);
          const waitSec = waitMatch ? parseInt(waitMatch[1], 10) : 5;
          this.logger.warn(`Rate limited, waiting ${waitSec}s (retry ${retries}/${EDIT_MAX_RETRIES})`);
          await new Promise((r) => setTimeout(r, waitSec * 1000));
          continue;
        }

        // Try without markdown (common issue with special characters)
        try {
          await this.bot.telegram.editMessageText(chatId, messageId, undefined, messageText);
          this.logger.debug(`Message ${messageId} edited in chat ${chatId} (plain text fallback)`);
          return true;
        } catch (plainError) {
          const plainErrorMsg = plainError instanceof Error ? plainError.message : String(plainError);
          if (plainErrorMsg.includes('message is not modified')) {
            return true;
          }

          // If edit completely failed and fallback enabled, send new message
          if (fallbackToNew) {
            this.logger.warn(`Edit failed, sending new message: ${plainErrorMsg}`);
            const result = await this.sendMessage(chatId, messageText);
            return result !== null;
          }

          this.logger.error(`Failed to edit message ${messageId} in chat ${chatId}: ${plainErrorMsg}`);
          return false;
        }
      }
    }

    // Max retries exceeded - fallback to new message if enabled
    if (fallbackToNew) {
      this.logger.warn(`Edit max retries exceeded, sending new message`);
      const result = await this.sendMessage(chatId, messageText);
      return result !== null;
    }
    return false;
  }

  /**
   * Edit message or send new - convenience method for progress updates.
   * Automatically falls back to new message if edit fails.
   */
  async editOrSendMessage(chatId: string, messageId: number, text: string): Promise<boolean> {
    return this.editMessage(chatId, messageId, text, true);
  }
}
