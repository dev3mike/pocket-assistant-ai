import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Pocket Assistant AI - Telegram Bot is running!';
  }
}
