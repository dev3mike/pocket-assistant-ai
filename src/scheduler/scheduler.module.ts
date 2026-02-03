import { Module, forwardRef } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { TelegramModule } from '../telegram/telegram.module';
import { AgentModule } from '../agent/agent.module';

@Module({
  imports: [forwardRef(() => TelegramModule), forwardRef(() => AgentModule)],
  providers: [SchedulerService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
