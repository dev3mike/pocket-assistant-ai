import { Module, forwardRef } from '@nestjs/common';
import { TelegramUpdate } from './telegram.update';
import { TelegramService } from './telegram.service';
import { AgentModule } from '../agent/agent.module';
import { LoggerModule } from '../logger/logger.module';
import { SoulModule } from '../soul/soul.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { AiModule } from '../ai/ai.module';
import { MemoryModule } from '../memory/memory.module';
import { FileModule } from '../file/file.module';
import { TranscriptionModule } from '../transcription/transcription.module';

@Module({
  imports: [
    AgentModule,
    LoggerModule,
    SoulModule,
    AiModule,
    forwardRef(() => SchedulerModule),
    MemoryModule,
    FileModule,
    TranscriptionModule,
  ],
  providers: [TelegramUpdate, TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
