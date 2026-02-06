import { Module, forwardRef } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { AgentModule } from '../agent/agent.module';

@Module({
  // MessagingModule is @Global, so MESSAGING_SERVICE is available without explicit import
  imports: [forwardRef(() => AgentModule)],
  providers: [SchedulerService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
