import { Module } from '@nestjs/common';
import { AgentLoggerService } from './agent-logger.service';

@Module({
  providers: [AgentLoggerService],
  exports: [AgentLoggerService],
})
export class LoggerModule {}
