import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TelegrafModule } from 'nestjs-telegraf';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TelegramModule } from './telegram/telegram.module';
import { MessagingModule } from './messaging/messaging.module';
import { AgentModule } from './agent/agent.module';
import { AppConfigModule } from './config/config.module';
import { SoulModule } from './soul/soul.module';
import { AiModule } from './ai/ai.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { BrowserModule } from './browser/browser.module';
import { UsageModule } from './usage/usage.module';
import { CoderModule } from './coder/coder.module';
import { ModelModule } from './model/model.module';
import { PromptModule } from './prompts/prompt.module';
import { TranscriptionModule } from './transcription/transcription.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    AppConfigModule,
    ModelModule,
    PromptModule,
    AiModule,
    SoulModule,
    UsageModule,
    TelegrafModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        token: configService.get<string>('TELEGRAM_BOT_TOKEN') || '',
        launchOptions: {
          // Use polling mode (simpler for development)
          // For production, you might want to use webhooks
        },
      }),
      inject: [ConfigService],
    }),
    TelegramModule,
    MessagingModule, // Global messaging abstraction layer (must come after TelegramModule)
    AgentModule,
    SchedulerModule,
    BrowserModule,
    CoderModule,
    TranscriptionModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
