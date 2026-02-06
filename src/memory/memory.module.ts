import { Module, forwardRef } from '@nestjs/common';
import { MemoryService } from './memory.service';
import { EmbeddingService } from './embedding.service';
import { LongTermMemoryService } from './longterm-memory.service';
import { SemanticSearchService } from './semantic-search.service';
import { AiModule } from '../ai/ai.module';
import { UsageModule } from '../usage/usage.module';

@Module({
  imports: [forwardRef(() => AiModule), UsageModule],
  providers: [
    MemoryService,
    EmbeddingService,
    LongTermMemoryService,
    SemanticSearchService,
  ],
  exports: [
    MemoryService,
    EmbeddingService,
    LongTermMemoryService,
    SemanticSearchService,
  ],
})
export class MemoryModule {}
