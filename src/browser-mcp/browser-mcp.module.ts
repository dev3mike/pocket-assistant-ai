/**
 * Browser MCP Module
 *
 * Provides Browser MCP integration for controlling the user's actual browser
 * via the Browser MCP Chrome extension and MCP protocol.
 */
import { Module, forwardRef } from '@nestjs/common';
import { BrowserMCPService } from './browser-mcp.service';
import { BrowserMCPAgentService } from './browser-mcp-agent.service';
import { LoggerModule } from '../logger/logger.module';
import { ModelModule } from '../model/model.module';

@Module({
  imports: [
    LoggerModule,
    ModelModule,
  ],
  providers: [
    BrowserMCPService,
    BrowserMCPAgentService,
  ],
  exports: [
    BrowserMCPService,
    BrowserMCPAgentService,
  ],
})
export class BrowserMCPModule {}
