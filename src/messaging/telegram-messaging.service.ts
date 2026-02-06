/**
 * TELEGRAM MESSAGING SERVICE – Telegram implementation of IMessagingService.
 * Wraps TelegramService to provide the standardized messaging interface.
 */
import { Injectable, Logger } from '@nestjs/common';
import { IMessagingService, MessageSendResult, MessageOptions } from './messaging.interface';
import { TelegramService } from '../telegram/telegram.service';

@Injectable()
export class TelegramMessagingService implements IMessagingService {
  private readonly logger = new Logger(TelegramMessagingService.name);

  constructor(private readonly telegramService: TelegramService) {}

  async sendMessage(
    recipientId: string,
    text: string,
    options?: MessageOptions,
  ): Promise<MessageSendResult> {
    try {
      const success = await this.telegramService.sendMessage(recipientId, text);
      return {
        success,
        error: success ? undefined : 'Failed to send message',
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to send message to ${recipientId}: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  async sendPhoto(
    recipientId: string,
    photoPath: string,
    caption?: string,
  ): Promise<MessageSendResult> {
    try {
      const success = await this.telegramService.sendPhoto(recipientId, photoPath, caption);
      return {
        success,
        error: success ? undefined : 'Failed to send photo',
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to send photo to ${recipientId}: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  async sendPhotos(
    recipientId: string,
    photoPaths: string[],
    caption?: string,
  ): Promise<MessageSendResult> {
    try {
      const success = await this.telegramService.sendPhotos(recipientId, photoPaths, caption);
      return {
        success,
        error: success ? undefined : 'Failed to send photos',
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to send photos to ${recipientId}: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  async sendScheduledReminder(
    recipientId: string,
    description: string,
    taskContext?: string,
  ): Promise<MessageSendResult> {
    try {
      const success = await this.telegramService.sendScheduledReminder(
        recipientId,
        description,
        taskContext,
      );
      return {
        success,
        error: success ? undefined : 'Failed to send reminder',
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to send reminder to ${recipientId}: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  getChannelType(): string {
    return 'telegram';
  }
}
