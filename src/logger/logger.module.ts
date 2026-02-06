import { Global, Module } from '@nestjs/common';
import { AgentLoggerService } from './agent-logger.service';
import { TraceService } from './trace.service';

@Global()
@Module({
  providers: [AgentLoggerService, TraceService],
  exports: [AgentLoggerService, TraceService],
})
export class LoggerModule {}
