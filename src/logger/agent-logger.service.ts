import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import * as fs from 'fs';
import * as path from 'path';

export enum LogLevel {
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
  DEBUG = 'debug',
}

export enum LogEvent {
  AGENT_INIT = 'agent_init',
  AGENT_READY = 'agent_ready',
  MCP_CONNECT = 'mcp_connect',
  MCP_TOOLS_LOADED = 'mcp_tools_loaded',
  MCP_FAILED = 'mcp_failed',
  MCP_CLEANUP = 'mcp_cleanup',
  TOOLS_BOUND = 'tools_bound',
  MESSAGE_RECEIVED = 'message_received',
  LLM_INVOKE = 'llm_invoke',
  LLM_RESPONSE = 'llm_response',
  TOOL_CALL_REQUESTED = 'tool_call_requested',
  TOOL_EXECUTING = 'tool_executing',
  TOOL_RESULT = 'tool_result',
  TOOL_ERROR = 'tool_error',
  ROUTING = 'routing',
  CONVERSATION_NEW = 'conversation_new',
  CONVERSATION_CLEARED = 'conversation_cleared',
  RESPONSE_SENT = 'response_sent',
  ERROR = 'error',
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  event: LogEvent;
  message: string;
  chatId?: string;
  data?: Record<string, any>;
}

@Injectable()
export class AgentLoggerService {
  private readonly logger = new Logger(AgentLoggerService.name);
  private readonly logsDir: string;

  constructor(private readonly configService: ConfigService) {
    this.logsDir = path.join(process.cwd(), 'logs');
  }

  private ensureLogsDirectory(): void {
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }
  }

  private getLogFilePath(): string {
    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    return path.join(this.logsDir, `${date}.json`);
  }

  private async writeToFile(entry: LogEntry): Promise<void> {
    this.ensureLogsDirectory();
    const filePath = this.getLogFilePath();

    try {
      let logs: LogEntry[] = [];

      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        try {
          logs = JSON.parse(content);
        } catch {
          logs = [];
        }
      }

      logs.push(entry);
      fs.writeFileSync(filePath, JSON.stringify(logs, null, 2));
    } catch (error) {
      this.logger.error(`Failed to write log to file: ${error}`);
    }
  }

  log(
    event: LogEvent,
    message: string,
    options?: { chatId?: string; data?: Record<string, any>; level?: LogLevel }
  ): void {
    if (!this.configService.isLoggingEnabled()) {
      return;
    }

    const level = options?.level ?? LogLevel.INFO;
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      event,
      message,
      ...(options?.chatId && { chatId: options.chatId }),
      ...(options?.data && { data: options.data }),
    };

    // Log to NestJS logger
    const logMessage = options?.chatId
      ? `[${options.chatId}] ${message}`
      : message;

    switch (level) {
      case LogLevel.ERROR:
        this.logger.error(logMessage, options?.data ? JSON.stringify(options.data) : '');
        break;
      case LogLevel.WARN:
        this.logger.warn(logMessage);
        break;
      case LogLevel.DEBUG:
        this.logger.debug(logMessage);
        break;
      default:
        this.logger.log(logMessage);
    }

    // Write to file asynchronously
    this.writeToFile(entry);
  }

  info(event: LogEvent, message: string, options?: { chatId?: string; data?: Record<string, any> }): void {
    this.log(event, message, { ...options, level: LogLevel.INFO });
  }

  warn(event: LogEvent, message: string, options?: { chatId?: string; data?: Record<string, any> }): void {
    this.log(event, message, { ...options, level: LogLevel.WARN });
  }

  error(event: LogEvent, message: string, options?: { chatId?: string; data?: Record<string, any> }): void {
    this.log(event, message, { ...options, level: LogLevel.ERROR });
  }

  debug(event: LogEvent, message: string, options?: { chatId?: string; data?: Record<string, any> }): void {
    this.log(event, message, { ...options, level: LogLevel.DEBUG });
  }
}
