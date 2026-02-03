import { Module, forwardRef } from '@nestjs/common';
import { BrowserAgentService } from './browser-agent.service';
import { BrowserToolsService } from './browser-tools.service';
import { TaskPlannerService } from './task-planner.service';
import { PageAnalyzerService } from './page-analyzer.service';
import { LoggerModule } from '../logger/logger.module';
import { AiModule } from '../ai/ai.module';
import { UsageModule } from '../usage/usage.module';

@Module({
  imports: [LoggerModule, forwardRef(() => AiModule), UsageModule],
  providers: [
    BrowserAgentService,
    BrowserToolsService,
    TaskPlannerService,
    PageAnalyzerService,
  ],
  exports: [BrowserAgentService],
})
export class BrowserModule {}
