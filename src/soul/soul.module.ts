import { Global, Module } from '@nestjs/common';
import { SoulService } from './soul.service';
import { AiModule } from '../ai/ai.module';

@Global()
@Module({
  imports: [AiModule],
  providers: [SoulService],
  exports: [SoulService],
})
export class SoulModule {}
