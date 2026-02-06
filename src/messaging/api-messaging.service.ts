/**
 * API MESSAGING SERVICE – Implementation of IMessagingService for REST API clients.
 * Use this when you want to expose the assistant via a REST API.
 *
 * This is an example/template. Customize based on your needs:
 * - WebSocket for real-time responses
 * - SSE (Server-Sent Events) for streaming
 * - Webhook callbacks for async responses
 */
import { Injectable, Logger } from '@nestjs/common';
import { IMessagingService, MessageSendResult, MessageOptions } from './messaging.interface';

/**
 * Pending messages storage - in production, use Redis or a message queue
 */
interface PendingMessage {
  id: string;
  recipientId: string;
  type: 'text' | 'photo' | 'reminder';
  text?: string;
  photoPath?: string;
  photos?: string[];
  caption?: string;
  timestamp: Date;
  retrieved: boolean;
}

@Injectable()
export class ApiMessagingService implements IMessagingService {
  private readonly logger = new Logger(ApiMessagingService.name);

  /**
   * In-memory message storage for demonstration.
   * Replace with Redis, a database, or a message queue for production.
   */
  private readonly pendingMessages: Map<string, PendingMessage[]> = new Map();

  /**
   * Optional webhook URL to notify when messages are ready
   */
  private webhookUrls: Map<string, string> = new Map();

  getChannelType(): string {
    return 'api';
  }

  /**
   * Register a webhook URL for a recipient
   */
  registerWebhook(recipientId: string, webhookUrl: string): void {
    this.webhookUrls.set(recipientId, webhookUrl);
  }

  /**
   * Store a message for API retrieval
   */
  async sendMessage(
    recipientId: string,
    text: string,
    options?: MessageOptions,
  ): Promise<MessageSendResult> {
    const messageId = this.generateMessageId();
    const message: PendingMessage = {
      id: messageId,
      recipientId,
      type: 'text',
      text,
      timestamp: new Date(),
      retrieved: false,
    };

    this.addPendingMessage(recipientId, message);
    this.logger.debug(`Queued message for ${recipientId}: ${text.slice(0, 50)}...`);

    // Optionally notify via webhook
    await this.notifyWebhook(recipientId, message);

    return { success: true, messageId };
  }

  async sendPhoto(
    recipientId: string,
    photoPath: string,
    caption?: string,
  ): Promise<MessageSendResult> {
    const messageId = this.generateMessageId();
    const message: PendingMessage = {
      id: messageId,
      recipientId,
      type: 'photo',
      photoPath,
      caption,
      timestamp: new Date(),
      retrieved: false,
    };

    this.addPendingMessage(recipientId, message);
    await this.notifyWebhook(recipientId, message);

    return { success: true, messageId };
  }

  async sendPhotos(
    recipientId: string,
    photoPaths: string[],
    caption?: string,
  ): Promise<MessageSendResult> {
    const messageId = this.generateMessageId();
    const message: PendingMessage = {
      id: messageId,
      recipientId,
      type: 'photo',
      photos: photoPaths,
      caption,
      timestamp: new Date(),
      retrieved: false,
    };

    this.addPendingMessage(recipientId, message);
    await this.notifyWebhook(recipientId, message);

    return { success: true, messageId };
  }

  async sendScheduledReminder(
    recipientId: string,
    description: string,
    taskContext?: string,
  ): Promise<MessageSendResult> {
    const text = taskContext
      ? `Reminder: ${description}\n\nContext: ${taskContext}`
      : `Reminder: ${description}`;

    return this.sendMessage(recipientId, text);
  }

  /**
   * Typing indicator is a no-op for API (could be WebSocket event)
   */
  async sendTypingIndicator(recipientId: string): Promise<void> {
    // For WebSocket implementation, emit a 'typing' event
    this.logger.debug(`Typing indicator for ${recipientId} (no-op for API)`);
  }

  /**
   * Get pending messages for a recipient (called by API endpoint)
   */
  getPendingMessages(recipientId: string, markAsRetrieved = true): PendingMessage[] {
    const messages = this.pendingMessages.get(recipientId) || [];
    const pending = messages.filter((m) => !m.retrieved);

    if (markAsRetrieved) {
      pending.forEach((m) => (m.retrieved = true));
    }

    return pending;
  }

  /**
   * Clear retrieved messages (cleanup)
   */
  clearRetrievedMessages(recipientId: string): void {
    const messages = this.pendingMessages.get(recipientId) || [];
    const unretrieved = messages.filter((m) => !m.retrieved);
    this.pendingMessages.set(recipientId, unretrieved);
  }

  private addPendingMessage(recipientId: string, message: PendingMessage): void {
    const existing = this.pendingMessages.get(recipientId) || [];
    existing.push(message);
    this.pendingMessages.set(recipientId, existing);
  }

  private generateMessageId(): string {
    return `api_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  private async notifyWebhook(recipientId: string, message: PendingMessage): Promise<void> {
    const webhookUrl = this.webhookUrls.get(recipientId);
    if (!webhookUrl) return;

    try {
      // In production, use a proper HTTP client
      this.logger.debug(`Would notify webhook: ${webhookUrl}`);
      // await fetch(webhookUrl, { method: 'POST', body: JSON.stringify(message) });
    } catch (error) {
      this.logger.warn(`Failed to notify webhook for ${recipientId}: ${error}`);
    }
  }
}
