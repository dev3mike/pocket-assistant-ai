/**
 * MESSAGING MODULE – Provides messaging abstraction layer.
 *
 * Configuration options:
 *
 * 1. Telegram only (default):
 *    - Uses TelegramMessagingService
 *    - All messages go through Telegram
 *
 * 2. Multi-channel (Telegram + API):
 *    - Set ENABLE_API_CHANNEL=true in environment
 *    - Messages are routed based on recipient ID:
 *      - "api:xxx" -> API channel (for REST clients)
 *      - numeric ID -> Telegram channel
 *
 * To switch to multi-channel:
 * 1. Set ENABLE_API_CHANNEL=true in .env
 * 2. Create API endpoints to receive/send messages
 */
import { Module, Global } from '@nestjs/common';
import { TelegramMessagingService } from './telegram-messaging.service';
import { ApiMessagingService } from './api-messaging.service';
import { MultiChannelMessagingService } from './multi-channel-messaging.service';
import { MESSAGING_SERVICE } from './messaging.interface';
import { TelegramModule } from '../telegram/telegram.module';

// Check if multi-channel mode is enabled
const isMultiChannelEnabled = process.env.ENABLE_API_CHANNEL === 'true';

@Global()
@Module({
  imports: [TelegramModule],
  providers: [
    TelegramMessagingService,
    ApiMessagingService,
    MultiChannelMessagingService,
    {
      provide: MESSAGING_SERVICE,
      useExisting: isMultiChannelEnabled
        ? MultiChannelMessagingService
        : TelegramMessagingService,
    },
  ],
  exports: [
    MESSAGING_SERVICE,
    TelegramMessagingService,
    ApiMessagingService,
    MultiChannelMessagingService,
  ],
})
export class MessagingModule {}
