/**
 * MULTI-CHANNEL MESSAGING SERVICE – Routes messages to the appropriate channel.
 * Use this when you want both Telegram and API to work simultaneously.
 *
 * Recipients are identified by their channel:
 * - Telegram: numeric chat IDs (e.g., "123456789")
 * - API: prefixed IDs (e.g., "api:user123" or "api:session-abc")
 */
import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { IMessagingService, MessageSendResult, MessageOptions } from './messaging.interface';
import { TelegramMessagingService } from './telegram-messaging.service';
import { ApiMessagingService } from './api-messaging.service';

@Injectable()
export class MultiChannelMessagingService implements IMessagingService {
  private readonly logger = new Logger(MultiChannelMessagingService.name);

  constructor(
    @Inject(forwardRef(() => TelegramMessagingService))
    private readonly telegramMessaging: TelegramMessagingService,
    @Inject(forwardRef(() => ApiMessagingService))
    private readonly apiMessaging: ApiMessagingService,
  ) {}

  getChannelType(): string {
    return 'multi';
  }

  /**
   * Determine which channel to use based on recipient ID format:
   * - "api:xxx" -> API channel
   * - numeric string -> Telegram channel
   */
  private getChannel(recipientId: string): IMessagingService {
    if (recipientId.startsWith('api:')) {
      return this.apiMessaging;
    }
    // Default to Telegram for numeric IDs (Telegram chat IDs are numbers)
    return this.telegramMessaging;
  }

  /**
   * Normalize recipient ID (strip channel prefix if present)
   */
  private normalizeRecipientId(recipientId: string): string {
    if (recipientId.startsWith('api:')) {
      return recipientId.slice(4); // Remove "api:" prefix
    }
    return recipientId;
  }

  async sendMessage(
    recipientId: string,
    text: string,
    options?: MessageOptions,
  ): Promise<MessageSendResult> {
    const channel = this.getChannel(recipientId);
    const normalizedId = this.normalizeRecipientId(recipientId);

    this.logger.debug(`Routing message to ${channel.getChannelType()} for ${normalizedId}`);

    return channel.sendMessage(normalizedId, text, options);
  }

  async sendPhoto(
    recipientId: string,
    photoPath: string,
    caption?: string,
  ): Promise<MessageSendResult> {
    const channel = this.getChannel(recipientId);
    const normalizedId = this.normalizeRecipientId(recipientId);

    return channel.sendPhoto(normalizedId, photoPath, caption);
  }

  async sendPhotos(
    recipientId: string,
    photoPaths: string[],
    caption?: string,
  ): Promise<MessageSendResult> {
    const channel = this.getChannel(recipientId);
    const normalizedId = this.normalizeRecipientId(recipientId);

    return channel.sendPhotos(normalizedId, photoPaths, caption);
  }

  async sendScheduledReminder(
    recipientId: string,
    description: string,
    taskContext?: string,
  ): Promise<MessageSendResult> {
    const channel = this.getChannel(recipientId);
    const normalizedId = this.normalizeRecipientId(recipientId);

    return channel.sendScheduledReminder(normalizedId, description, taskContext);
  }

  async sendTypingIndicator(recipientId: string): Promise<void> {
    const channel = this.getChannel(recipientId);
    const normalizedId = this.normalizeRecipientId(recipientId);

    if (channel.sendTypingIndicator) {
      await channel.sendTypingIndicator(normalizedId);
    }
  }

  async updateMessage(
    recipientId: string,
    messageId: string,
    text: string,
    options?: MessageOptions,
  ): Promise<MessageSendResult> {
    const channel = this.getChannel(recipientId);
    const normalizedId = this.normalizeRecipientId(recipientId);

    if (channel.updateMessage) {
      return channel.updateMessage(normalizedId, messageId, text, options);
    }

    // Fallback to sending new message
    return channel.sendMessage(normalizedId, text, options);
  }

  supportsMessageUpdate(): boolean {
    // Both channels support message updates
    return true;
  }

  /**
   * Broadcast a message to multiple channels
   */
  async broadcast(
    recipientIds: string[],
    text: string,
    options?: MessageOptions,
  ): Promise<Map<string, MessageSendResult>> {
    const results = new Map<string, MessageSendResult>();

    for (const recipientId of recipientIds) {
      try {
        const result = await this.sendMessage(recipientId, text, options);
        results.set(recipientId, result);
      } catch (error) {
        results.set(recipientId, {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }
}
