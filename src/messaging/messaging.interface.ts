/**
 * MESSAGING INTERFACE – Abstraction layer for message delivery.
 * Allows different messaging backends (Telegram, REST API, WebSocket, etc.)
 * to be used interchangeably by the agent and scheduler services.
 */

/**
 * Result of a message send operation
 */
export interface MessageSendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Options for sending messages
 */
export interface MessageOptions {
  parseMode?: 'markdown' | 'html' | 'plain';
  replyToMessageId?: string;
}

/**
 * Interface for messaging services
 * Implement this interface to add new messaging channels (e.g., REST API, WebSocket)
 */
export interface IMessagingService {
  /**
   * Send a text message to a recipient
   * @param recipientId - The recipient identifier (e.g., chat ID, user ID)
   * @param text - The message text
   * @param options - Optional message options
   */
  sendMessage(recipientId: string, text: string, options?: MessageOptions): Promise<MessageSendResult>;

  /**
   * Send a photo to a recipient
   * @param recipientId - The recipient identifier
   * @param photoPath - Path to the photo file
   * @param caption - Optional caption for the photo
   */
  sendPhoto(recipientId: string, photoPath: string, caption?: string): Promise<MessageSendResult>;

  /**
   * Send multiple photos to a recipient
   * @param recipientId - The recipient identifier
   * @param photoPaths - Array of paths to photo files
   * @param caption - Optional caption for the first photo
   */
  sendPhotos(recipientId: string, photoPaths: string[], caption?: string): Promise<MessageSendResult>;

  /**
   * Send a scheduled reminder message
   * @param recipientId - The recipient identifier
   * @param description - The reminder description
   * @param taskContext - Optional context for the reminder
   */
  sendScheduledReminder(recipientId: string, description: string, taskContext?: string): Promise<MessageSendResult>;

  /**
   * Send a typing indicator (if supported by the channel)
   * @param recipientId - The recipient identifier
   */
  sendTypingIndicator?(recipientId: string): Promise<void>;

  /**
   * Get the channel type identifier
   */
  getChannelType(): string;
}

/**
 * Token for dependency injection of the messaging service
 */
export const MESSAGING_SERVICE = Symbol('MESSAGING_SERVICE');
