/**
 * BROWSER MCP SERVICE - Manages connection to Browser MCP server
 *
 * Browser MCP connects AI to your actual browser via a Chrome extension.
 * Unlike Playwright-based automation, this uses your logged-in browser session
 * and preserves cookies, auth state, and extensions.
 *
 * Prerequisites:
 * 1. Node.js installed
 * 2. Browser MCP Chrome extension installed (https://browsermcp.io)
 * 3. The extension must be running/connected
 *
 * The service manages the MCP server connection and provides access to tools:
 * - navigate: Go to URLs
 * - click: Click elements
 * - type: Type text
 * - screenshot: Capture screenshots
 * - select: Select dropdown options
 * - drag: Drag elements
 * - And more...
 */
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { StructuredTool } from '@langchain/core/tools';
import { AgentLoggerService, LogEvent } from '../logger/agent-logger.service';

export interface BrowserMCPTool {
  name: string;
  description: string;
  invoke: (args: Record<string, any>) => Promise<string>;
}

@Injectable()
export class BrowserMCPService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BrowserMCPService.name);
  private mcpClient: MultiServerMCPClient | null = null;
  private tools: Record<string, StructuredTool> = {};
  private isConnected = false;
  private connectionAttempts = 0;
  private readonly maxConnectionAttempts = 3;

  constructor(
    private readonly agentLogger: AgentLoggerService,
  ) {}

  async onModuleInit() {
    // Don't auto-connect on startup - connect on demand to save resources
    this.logger.log('BrowserMCPService initialized (will connect on first use)');
  }

  async onModuleDestroy() {
    await this.disconnect();
  }

  /**
   * Check if Browser MCP is connected and ready
   */
  isReady(): boolean {
    return this.isConnected && Object.keys(this.tools).length > 0;
  }

  /**
   * Get available Browser MCP tools
   */
  getTools(): Record<string, StructuredTool> {
    return this.tools;
  }

  /**
   * Get list of available tool names
   */
  getToolNames(): string[] {
    return Object.keys(this.tools);
  }

  /**
   * Connect to Browser MCP server
   * Spawns the MCP server process and establishes connection
   */
  async connect(): Promise<{ success: boolean; error?: string; tools?: string[] }> {
    if (this.isConnected) {
      return { success: true, tools: this.getToolNames() };
    }

    this.connectionAttempts++;
    if (this.connectionAttempts > this.maxConnectionAttempts) {
      return {
        success: false,
        error: `Failed to connect after ${this.maxConnectionAttempts} attempts. Please ensure the Browser MCP Chrome extension is installed and running.`,
      };
    }

    this.agentLogger.info(LogEvent.MCP_CONNECT, 'Connecting to Browser MCP server');
    this.logger.log('Connecting to Browser MCP server...');

    try {
      // Create MCP client that will spawn the Browser MCP server
      this.mcpClient = new MultiServerMCPClient({
        browsermcp: {
          transport: 'stdio',
          command: 'npx',
          args: ['@browsermcp/mcp@latest'],
        },
      });

      // Get tools from the MCP server
      const mcpTools = await this.withTimeout(
        this.mcpClient.getTools(),
        30000, // 30 second timeout for initial connection
        'Browser MCP connection',
      );

      if (mcpTools.length === 0) {
        throw new Error('No tools available from Browser MCP. Is the Chrome extension running?');
      }

      // Store tools by name for easy access
      this.tools = {};
      for (const tool of mcpTools) {
        this.tools[tool.name] = tool as StructuredTool;
      }

      this.isConnected = true;
      this.connectionAttempts = 0; // Reset on success

      const toolNames = this.getToolNames();
      this.agentLogger.info(LogEvent.MCP_TOOLS_LOADED, `Loaded ${toolNames.length} Browser MCP tools`, {
        data: { tools: toolNames },
      });
      this.logger.log(`Connected to Browser MCP with ${toolNames.length} tools: ${toolNames.join(', ')}`);

      return { success: true, tools: toolNames };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.agentLogger.error(LogEvent.MCP_FAILED, `Browser MCP connection failed: ${errorMsg}`);
      this.logger.error(`Failed to connect to Browser MCP: ${errorMsg}`);

      // Clean up on failure
      await this.disconnect();

      return {
        success: false,
        error: this.formatConnectionError(errorMsg),
      };
    }
  }

  /**
   * Disconnect from Browser MCP server
   */
  async disconnect(): Promise<void> {
    if (this.mcpClient) {
      try {
        await this.mcpClient.close();
      } catch (error) {
        this.logger.warn(`Error closing MCP client: ${error}`);
      }
      this.mcpClient = null;
    }

    this.tools = {};
    this.isConnected = false;
    this.logger.log('Disconnected from Browser MCP');
  }

  /**
   * Execute a Browser MCP tool
   */
  async executeTool(
    toolName: string,
    args: Record<string, any>,
  ): Promise<{ success: boolean; result?: any; error?: string }> {
    // Ensure connected
    if (!this.isConnected) {
      const connectResult = await this.connect();
      if (!connectResult.success) {
        return { success: false, error: connectResult.error };
      }
    }

    const tool = this.tools[toolName];
    if (!tool) {
      return {
        success: false,
        error: `Tool "${toolName}" not found. Available tools: ${this.getToolNames().join(', ')}`,
      };
    }

    try {
      this.agentLogger.info(LogEvent.TOOL_EXECUTING, `Executing Browser MCP tool: ${toolName}`, {
        data: { args },
      });

      const result = await this.withTimeout(
        tool.invoke(args),
        60000, // 60 second timeout for tool execution
        `Browser MCP tool: ${toolName}`,
      );

      this.agentLogger.info(LogEvent.TOOL_RESULT, `Browser MCP tool ${toolName} completed`, {
        data: { resultPreview: String(result).slice(0, 200) },
      });

      // Parse result if it's JSON
      let parsedResult = result;
      if (typeof result === 'string') {
        try {
          parsedResult = JSON.parse(result);
        } catch {
          // Keep as string if not valid JSON
        }
      }

      // Debug logging for screenshot tool
      if (toolName === 'browser_screenshot') {
        const resultType = typeof parsedResult;
        const resultKeys = parsedResult && typeof parsedResult === 'object' ? Object.keys(parsedResult) : [];
        const resultLength = typeof result === 'string' ? result.length : JSON.stringify(parsedResult).length;
        this.logger.debug(`Screenshot tool result - type: ${resultType}, keys: [${resultKeys.join(', ')}], length: ${resultLength}`);
        
        // Check for base64 data in various locations
        if (parsedResult?.data) this.logger.debug(`Screenshot has 'data' field, length: ${parsedResult.data.length}`);
        if (parsedResult?.base64) this.logger.debug(`Screenshot has 'base64' field, length: ${parsedResult.base64.length}`);
        if (parsedResult?.image) this.logger.debug(`Screenshot has 'image' field, length: ${parsedResult.image.length}`);
        if (typeof result === 'string' && result.startsWith('data:image')) {
          this.logger.debug(`Screenshot result is a data URI, length: ${result.length}`);
        }
      }

      return { success: true, result: parsedResult };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.agentLogger.error(LogEvent.TOOL_ERROR, `Browser MCP tool ${toolName} failed: ${errorMsg}`);

      // Check if connection was lost
      if (errorMsg.includes('closed') || errorMsg.includes('disconnected')) {
        this.isConnected = false;
        return {
          success: false,
          error: 'Connection to Browser MCP was lost. Please try again.',
        };
      }

      return { success: false, error: errorMsg };
    }
  }

  /**
   * Helper to add timeout to promises
   */
  private withTimeout<T>(promise: Promise<T>, ms: number, operation: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`${operation} timed out after ${ms}ms`)), ms),
      ),
    ]);
  }

  /**
   * Format connection error with helpful guidance
   */
  private formatConnectionError(error: string): string {
    if (error.includes('ENOENT') || error.includes('npx')) {
      return 'Node.js/npx not found. Please ensure Node.js is installed.';
    }
    if (error.includes('timeout')) {
      return 'Connection timed out. Please ensure the Browser MCP Chrome extension is installed and the browser is open.';
    }
    if (error.includes('No tools available')) {
      return 'Browser MCP connected but no tools available. Please check that the Chrome extension is properly configured and your browser is open.';
    }
    return `Browser MCP error: ${error}. Please ensure:\n1. The Browser MCP Chrome extension is installed\n2. Your browser is open\n3. The extension is connected`;
  }

  /**
   * Get a description of all available tools for the AI
   */
  getToolDescriptions(): string {
    if (!this.isConnected || Object.keys(this.tools).length === 0) {
      return 'Browser MCP not connected. Available after connection.';
    }

    const descriptions: string[] = ['Available Browser MCP tools:'];
    for (const [name, tool] of Object.entries(this.tools)) {
      descriptions.push(`- ${name}: ${tool.description}`);
    }
    return descriptions.join('\n');
  }
}
