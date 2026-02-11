import { Module, forwardRef } from '@nestjs/common';
import { MemoryService } from './memory.service';
import { LongTermMemoryService } from './longterm-memory.service';
import { AiModule } from '../ai/ai.module';
import { UsageModule } from '../usage/usage.module';

@Module({
  imports: [forwardRef(() => AiModule), UsageModule],
  providers: [MemoryService, LongTermMemoryService],
  exports: [MemoryService, LongTermMemoryService],
})
export class MemoryModule {}
