import { Global, Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { UsageModule } from '../usage/usage.module';

@Global()
@Module({
  imports: [UsageModule],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
