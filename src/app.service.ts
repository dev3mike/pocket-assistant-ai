/**
 * Simple root/health response for the HTTP server (e.g. GET / returns a welcome message).
 * No agent or Telegram logic.
 */
import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Pocket Assistant AI - Telegram Bot is running!';
  }
}
