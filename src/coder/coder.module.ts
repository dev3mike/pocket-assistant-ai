import { Module } from '@nestjs/common';
import { CoderAgentService } from './coder-agent.service';
import { CoderToolsService } from './coder-tools.service';
import { ProcessManagerService } from './process-manager.service';
import { UsageModule } from '../usage/usage.module';
import { AiModule } from '../ai/ai.module';

@Module({
  // MessagingModule is @Global, so MESSAGING_SERVICE is available without explicit import
  imports: [UsageModule, AiModule],
  providers: [CoderAgentService, CoderToolsService, ProcessManagerService],
  exports: [CoderAgentService, ProcessManagerService],
})
export class CoderModule {}
