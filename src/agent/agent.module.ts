import { Module, forwardRef } from '@nestjs/common';
import { AgentService } from './agent.service';
import { ToolsService } from './tools.service';
import { LoggerModule } from '../logger/logger.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { BrowserModule } from '../browser/browser.module';
import { MemoryModule } from '../memory/memory.module';
import { UsageModule } from '../usage/usage.module';
import { CoderModule } from '../coder/coder.module';

@Module({
  imports: [
    LoggerModule,
    forwardRef(() => SchedulerModule),
    BrowserModule,
    MemoryModule,
    UsageModule,
    forwardRef(() => CoderModule),
  ],
  providers: [AgentService, ToolsService],
  exports: [AgentService],
})
export class AgentModule {}
