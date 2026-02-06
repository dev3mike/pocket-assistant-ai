import { Module } from '@nestjs/common';
import { CoderAgentService } from './coder-agent.service';
import { CoderToolsService } from './coder-tools.service';
import { CoderRouterService } from './coder-router.service';
import { UsageModule } from '../usage/usage.module';
import { AiModule } from '../ai/ai.module';

@Module({
  // MessagingModule is @Global, so MESSAGING_SERVICE is available without explicit import
  imports: [UsageModule, AiModule],
  providers: [CoderAgentService, CoderToolsService, CoderRouterService],
  exports: [CoderAgentService, CoderRouterService],
})
export class CoderModule {}
