/**
 * BROWSER MCP AGENT - Interactive multi-step browser automation
 *
 * This agent handles complex browser tasks that may require multiple steps
 * and can ask the user questions during execution when clarification is needed.
 *
 * Key features:
 * - Multi-step task execution using Browser MCP tools
 * - Interactive mode: can pause and ask user questions mid-task
 * - Uses LLM to plan and adapt steps based on page content
 * - Returns screenshots and extracted data
 *
 * The agent works by:
 * 1. Analyzing the user's request
 * 2. Planning steps using available Browser MCP tools
 * 3. Executing steps one by one
 * 4. If stuck or needs clarification, asking the user
 * 5. Adapting based on what's seen on the page
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, HumanMessage, SystemMessage, BaseMessage } from '@langchain/core/messages';
import { BrowserMCPService } from './browser-mcp.service';
import { AgentLoggerService, LogEvent } from '../logger/agent-logger.service';
import { ModelFactoryService } from '../model/model-factory.service';
import * as fs from 'fs';
import * as path from 'path';

export interface BrowserMCPTaskResult {
  success: boolean;
  summary: string;
  stepsCompleted: string[];
  extractedData?: any[];
  screenshots?: string[];
  error?: string;
  needsUserInput?: boolean;
  question?: string;
  sessionId?: string;
}

export interface BrowserMCPSession {
  id: string;
  chatId: string;
  task: string;
  status: 'running' | 'waiting_for_input' | 'completed' | 'failed';
  messages: BaseMessage[];
  stepsCompleted: string[];
  extractedData: any[];
  screenshots: string[];
  currentQuestion?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Maximum steps to prevent infinite loops
const MAX_STEPS = 30;
const MAX_RETRIES_PER_STEP = 2;
const MAX_EMPTY_RESPONSES = 3; // Maximum consecutive empty/unknown responses before taking action
const SESSION_CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

@Injectable()
export class BrowserMCPAgentService implements OnModuleDestroy {
  private readonly logger = new Logger(BrowserMCPAgentService.name);
  private model: ChatOpenAI;
  private sessions: Map<string, BrowserMCPSession> = new Map();
  private isInitialized = false;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly browserMCP: BrowserMCPService,
    private readonly agentLogger: AgentLoggerService,
    private readonly modelFactory: ModelFactoryService,
  ) {
    this.initialize();
  }

  private initialize(): void {
    if (!process.env.OPENROUTER_API_KEY) {
      this.logger.warn('OPENROUTER_API_KEY not set, Browser MCP agent will not work');
      return;
    }

    this.model = this.modelFactory.getModel('main');
    this.isInitialized = true;

    // Start automatic session cleanup
    this.cleanupInterval = setInterval(() => {
      this.cleanupSessions(SESSION_MAX_AGE_MS);
    }, SESSION_CLEANUP_INTERVAL_MS);

    this.logger.log('Browser MCP agent service initialized');
  }

  /**
   * Cleanup on module destroy
   */
  onModuleDestroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Start a new browser automation task
   */
  async executeTask(
    task: string,
    chatId: string,
  ): Promise<BrowserMCPTaskResult> {
    if (!this.isInitialized) {
      return {
        success: false,
        summary: 'Browser MCP agent not initialized',
        stepsCompleted: [],
        error: 'OPENROUTER_API_KEY not configured',
      };
    }

    // Connect to Browser MCP
    const connectResult = await this.browserMCP.connect();
    if (!connectResult.success) {
      return {
        success: false,
        summary: 'Failed to connect to Browser MCP',
        stepsCompleted: [],
        error: connectResult.error,
      };
    }

    // Create a new session
    const sessionId = `bmcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const session: BrowserMCPSession = {
      id: sessionId,
      chatId,
      task,
      status: 'running',
      messages: [],
      stepsCompleted: [],
      extractedData: [],
      screenshots: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.sessions.set(session.id, session);

    this.agentLogger.info(LogEvent.AGENT_INIT, `Starting Browser MCP task: ${task}`, { chatId });

    try {
      // Run the agent loop
      const result = await this.runAgentLoop(session);
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.agentLogger.error(LogEvent.ERROR, `Browser MCP task failed: ${errorMsg}`, { chatId });

      session.status = 'failed';
      this.sessions.set(session.id, session);

      return {
        success: false,
        summary: `Task failed: ${errorMsg}`,
        stepsCompleted: session.stepsCompleted,
        extractedData: session.extractedData.length > 0 ? session.extractedData : undefined,
        screenshots: session.screenshots.length > 0 ? session.screenshots : undefined,
        error: errorMsg,
        sessionId,
      };
    }
  }

  /**
   * Continue a session after user provides input
   */
  async continueWithInput(
    sessionId: string,
    userInput: string,
  ): Promise<BrowserMCPTaskResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        success: false,
        summary: 'Session not found or expired',
        stepsCompleted: [],
        error: `Session ${sessionId} not found`,
      };
    }

    if (session.status !== 'waiting_for_input') {
      return {
        success: false,
        summary: 'Session is not waiting for input',
        stepsCompleted: session.stepsCompleted,
        error: `Session status is ${session.status}, not waiting_for_input`,
      };
    }

    // Add user's response to messages
    session.messages.push(new HumanMessage(userInput));
    session.status = 'running';
    session.currentQuestion = undefined;
    session.updatedAt = new Date();

    this.agentLogger.info(LogEvent.MESSAGE_RECEIVED, `User provided input for Browser MCP session`, {
      chatId: session.chatId,
      data: { sessionId, input: userInput.slice(0, 100) },
    });

    try {
      // Continue the agent loop
      const result = await this.runAgentLoop(session);
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      session.status = 'failed';
      this.sessions.set(session.id, session);

      return {
        success: false,
        summary: `Task failed: ${errorMsg}`,
        stepsCompleted: session.stepsCompleted,
        error: errorMsg,
        sessionId,
      };
    }
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId: string): BrowserMCPSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Main agent loop that executes steps
   * 
   * IMPORTANT: Message structure follows Human/AI alternation pattern for LLM compatibility.
   * Tool results and context are embedded in HumanMessage to maintain proper alternation.
   */
  private async runAgentLoop(session: BrowserMCPSession): Promise<BrowserMCPTaskResult> {
    const tools = this.browserMCP.getTools();
    const toolNames = Object.keys(tools);

    // Build system prompt with available tools
    const systemPrompt = this.buildSystemPrompt(toolNames);

    let stepCount = 0;
    let retryCount = 0;
    let emptyResponseCount = 0;
    let lastToolResult: string | null = null;
    let lastSnapshotContent: string | null = null;

    while (stepCount < MAX_STEPS) {
      stepCount++;

      // Build messages with proper Human/AI alternation
      // Format: System -> Human (task + context) -> [AI -> Human (result)]* 
      const messages: BaseMessage[] = [
        new SystemMessage(systemPrompt),
      ];

      // Build the initial human message with task and any accumulated context
      let humanContent = `Task: ${session.task}`;

      if (session.stepsCompleted.length > 0) {
        humanContent += `\n\nSteps completed so far:\n${session.stepsCompleted.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
      }

      messages.push(new HumanMessage(humanContent));

      // Add conversation history (AI responses and tool results as Human messages)
      for (const msg of session.messages) {
        messages.push(msg);
      }

      // If we have pending tool result or snapshot, add as the final Human message
      if (lastToolResult || lastSnapshotContent) {
        let contextMsg = '';
        if (lastToolResult) {
          contextMsg += `Tool result:\n${lastToolResult}`;
        }
        if (lastSnapshotContent) {
          contextMsg += `${lastToolResult ? '\n\n' : ''}Current page state:\n${lastSnapshotContent}`;
        }
        messages.push(new HumanMessage(contextMsg));

        // Clear after adding to prevent duplication
        lastToolResult = null;
        lastSnapshotContent = null;
      }

      // Get next action from LLM
      this.logger.debug(`Invoking LLM with ${messages.length} messages`);
      const response = await this.model.invoke(messages);

      // Debug: log raw response structure
      this.logger.debug(`LLM response keys: ${Object.keys(response || {}).join(', ')}`);
      this.logger.debug(`LLM response.content type: ${typeof response.content}, isArray: ${Array.isArray(response.content)}`);
      if (response.content) {
        const preview = typeof response.content === 'string'
          ? response.content.slice(0, 200)
          : JSON.stringify(response.content).slice(0, 200);
        this.logger.debug(`LLM response.content preview: ${preview}`);
      }

      // Check for empty response - handle various empty response formats
      const content = response.content;
      const hasContent = content && (
        typeof content === 'string'
          ? content.trim().length > 0
          : Array.isArray(content)
            ? content.length > 0
            : true
      );

      if (!hasContent) {
        this.logger.warn(`Empty response from LLM. Response type: ${typeof content}, value: ${JSON.stringify(content)?.slice(0, 100)}`);
        emptyResponseCount++;

        // If we get too many empty responses, try to recover by getting a snapshot
        if (emptyResponseCount >= MAX_EMPTY_RESPONSES) {
          this.logger.warn(`${emptyResponseCount} consecutive empty responses, attempting recovery with snapshot`);
          const snapshotResult = await this.getPageSnapshot();
          if (snapshotResult) {
            // Set snapshot for next iteration - will be added as context
            lastSnapshotContent = snapshotResult.slice(0, 4000);
            lastToolResult = 'Recovery: fetched current page state after empty responses.';
            emptyResponseCount = 0; // Reset after providing context
          } else {
            // If snapshot also fails, report the error
            session.status = 'failed';
            this.sessions.set(session.id, session);
            return {
              success: false,
              summary: 'Agent stopped responding and recovery failed',
              stepsCompleted: session.stepsCompleted,
              error: `LLM produced ${emptyResponseCount} consecutive empty responses`,
              sessionId: session.id,
            };
          }
        }
        continue;
      }

      // Reset empty response counter on valid response
      emptyResponseCount = 0;

      const responseText = typeof content === 'string'
        ? content
        : JSON.stringify(content);

      session.messages.push(new AIMessage(responseText));
      session.updatedAt = new Date();

      // Parse the response to determine action
      const action = this.parseAgentResponse(responseText);

      if (action.type === 'complete') {
        // Task completed successfully
        session.status = 'completed';
        this.sessions.set(session.id, session);

        return {
          success: true,
          summary: action.message || 'Task completed successfully',
          stepsCompleted: session.stepsCompleted,
          extractedData: session.extractedData.length > 0 ? session.extractedData : undefined,
          screenshots: session.screenshots.length > 0 ? session.screenshots : undefined,
          sessionId: session.id,
        };
      }

      if (action.type === 'ask_user') {
        // Need user input
        session.status = 'waiting_for_input';
        session.currentQuestion = action.question;
        this.sessions.set(session.id, session);

        return {
          success: true,
          summary: 'Waiting for your input',
          stepsCompleted: session.stepsCompleted,
          extractedData: session.extractedData.length > 0 ? session.extractedData : undefined,
          screenshots: session.screenshots.length > 0 ? session.screenshots : undefined,
          needsUserInput: true,
          question: action.question,
          sessionId: session.id,
        };
      }

      if (action.type === 'execute_tool') {
        // Enrich args for tools that require 'element' parameter
        const enrichedArgs = { ...(action.args || {}) };
        const toolsNeedingElement = ['browser_click', 'browser_hover', 'browser_type', 'browser_select_option'];
        if (toolsNeedingElement.includes(action.toolName!) && !enrichedArgs.element && action.description) {
          // Use the description as the element description if not provided
          enrichedArgs.element = action.description;
          this.logger.debug(`Auto-populated 'element' parameter from description: ${action.description}`);
        }

        // Execute a Browser MCP tool
        const toolResult = await this.browserMCP.executeTool(action.toolName!, enrichedArgs);

        if (toolResult.success) {
          session.stepsCompleted.push(`${action.toolName}: ${action.description || 'completed'}`);

          // Handle screenshot results
          if (action.toolName === 'browser_screenshot') {
            const savedPath = await this.extractAndSaveScreenshot(toolResult.result, session.id);
            if (savedPath) {
              session.screenshots.push(savedPath);
            }
          }

          // Store extracted data if present
          if (toolResult.result?.data || toolResult.result?.text || toolResult.result?.content) {
            session.extractedData.push({
              tool: action.toolName,
              data: toolResult.result.data || toolResult.result.text || toolResult.result.content,
            });
          }

          // Prepare result for next iteration (will be added as HumanMessage)
          const resultStr = typeof toolResult.result === 'string'
            ? toolResult.result
            : JSON.stringify(toolResult.result);
          lastToolResult = `${action.toolName} completed: ${resultStr.slice(0, 2000)}`;

          // After navigation or click actions, automatically get a snapshot for context
          if (['browser_navigate', 'browser_click', 'browser_type', 'browser_select_option', 'browser_press_key'].includes(action.toolName!)) {
            const snapshotResult = await this.getPageSnapshot();
            if (snapshotResult) {
              lastSnapshotContent = snapshotResult.slice(0, 4000);
            }
          }

          // If this was a snapshot tool, update our cached snapshot
          if (action.toolName === 'browser_snapshot' && resultStr) {
            lastSnapshotContent = resultStr.slice(0, 4000);
          }

          retryCount = 0; // Reset retry count on success
        } else {
          // Tool failed - add as context for next iteration
          retryCount++;
          lastToolResult = `${action.toolName} FAILED: ${toolResult.error}`;

          if (retryCount >= MAX_RETRIES_PER_STEP) {
            session.status = 'failed';
            this.sessions.set(session.id, session);

            return {
              success: false,
              summary: `Failed after ${retryCount} retries: ${toolResult.error}`,
              stepsCompleted: session.stepsCompleted,
              error: toolResult.error,
              sessionId: session.id,
            };
          }
        }
      }

      if (action.type === 'error') {
        session.status = 'failed';
        this.sessions.set(session.id, session);

        return {
          success: false,
          summary: action.message || 'Task failed',
          stepsCompleted: session.stepsCompleted,
          error: action.message,
          sessionId: session.id,
        };
      }

      // Handle unknown action type - LLM response couldn't be parsed
      if (action.type === 'unknown') {
        this.logger.warn(`Could not parse LLM response: ${responseText.slice(0, 200)}`);
        emptyResponseCount++;

        if (emptyResponseCount >= MAX_EMPTY_RESPONSES) {
          // Try to help the LLM by providing a snapshot and reminding it of the format
          const snapshotResult = await this.getPageSnapshot();
          if (snapshotResult) {
            lastSnapshotContent = snapshotResult.slice(0, 4000);
            // Add guidance as a Human message (after the AI message already added above)
            session.messages.push(new HumanMessage(
              `I couldn't understand your response. Please respond with ONLY a JSON code block.\n\nCurrent page:\n${lastSnapshotContent}\n\nRespond with:\n\`\`\`json\n{"action": "execute_tool", "tool": "browser_click", "args": {"element": "Button description", "ref": "s2e47"}, "description": "Click the button"}\n\`\`\``
            ));
            emptyResponseCount = 0;
          } else {
            session.status = 'failed';
            this.sessions.set(session.id, session);
            return {
              success: false,
              summary: 'Agent produced unparseable responses',
              stepsCompleted: session.stepsCompleted,
              error: `Could not parse LLM response after ${MAX_EMPTY_RESPONSES} attempts`,
              sessionId: session.id,
            };
          }
        } else {
          // Add a gentle reminder as Human message
          session.messages.push(new HumanMessage(
            `Your response couldn't be parsed. Please respond with ONLY a JSON code block like:\n\`\`\`json\n{"action": "execute_tool", "tool": "browser_snapshot", "args": {}, "description": "Check page"}\n\`\`\``
          ));
        }
      }

      this.sessions.set(session.id, session);
    }

    // Max steps reached
    session.status = 'failed';
    this.sessions.set(session.id, session);

    return {
      success: false,
      summary: `Task exceeded maximum steps (${MAX_STEPS})`,
      stepsCompleted: session.stepsCompleted,
      error: 'Maximum step limit reached',
      sessionId: session.id,
    };
  }

  /**
   * Get a browser snapshot for context
   */
  private async getPageSnapshot(): Promise<string | null> {
    try {
      const result = await this.browserMCP.executeTool('browser_snapshot', {});
      if (result.success && result.result) {
        const resultStr = typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
        return resultStr;
      }
    } catch (error) {
      this.logger.warn(`Failed to get page snapshot: ${error}`);
    }
    return null;
  }

  /**
   * Save a base64 encoded screenshot to file
   */
  private async saveBase64Screenshot(base64Data: string, sessionId: string): Promise<string | null> {
    try {
      const screenshotsDir = path.join(process.cwd(), 'data', 'screenshots');
      if (!fs.existsSync(screenshotsDir)) {
        fs.mkdirSync(screenshotsDir, { recursive: true });
      }

      const filename = `browser-mcp-${sessionId}-${Date.now()}.png`;
      const filePath = path.join(screenshotsDir, filename);

      // Remove data URI prefix if present
      const cleanBase64 = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;
      const buffer = Buffer.from(cleanBase64, 'base64');
      fs.writeFileSync(filePath, buffer);

      this.logger.log(`Saved screenshot: ${filePath} (${buffer.length} bytes)`);
      return filePath;
    } catch (error) {
      this.logger.error(`Failed to save screenshot: ${error}`);
      return null;
    }
  }

  /**
   * Extract base64 data from various screenshot result formats and save to file
   */
  private async extractAndSaveScreenshot(result: any, sessionId: string): Promise<string | null> {
    if (!result) return null;

    // Try to extract base64 data from various formats
    const base64Data = this.extractBase64FromResult(result);
    if (base64Data) {
      return this.saveBase64Screenshot(base64Data, sessionId);
    }

    // Check if result is a file path
    const filePath = this.extractFilePathFromResult(result);
    if (filePath) {
      this.logger.log(`Screenshot path extracted: ${filePath}`);
      return filePath;
    }

    this.logger.warn(`Could not extract screenshot from result type: ${typeof result}`);
    return null;
  }

  /**
   * Try to extract base64 image data from various result formats
   */
  private extractBase64FromResult(result: any): string | null {
    // Direct base64 string or data URI
    if (typeof result === 'string') {
      if (result.startsWith('data:image')) {
        return result.split(',')[1] || null;
      }
      // Check if it's raw base64 (starts with typical PNG/JPEG base64 patterns)
      if (result.match(/^[A-Za-z0-9+/=]{100,}$/)) {
        return result;
      }
      return null;
    }

    // Array format: [{"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}]
    if (Array.isArray(result)) {
      for (const item of result) {
        // OpenAI vision format
        if (item?.type === 'image_url' && item?.image_url?.url?.startsWith('data:image')) {
          return item.image_url.url.split(',')[1] || null;
        }
        // Direct data field
        if (item?.data && typeof item.data === 'string') {
          return item.data;
        }
      }
      return null;
    }

    // Object with data/base64/image field
    if (typeof result === 'object') {
      const data = result.data || result.base64 || result.image;
      if (typeof data === 'string') {
        return data.startsWith('data:image') ? data.split(',')[1] : data;
      }
    }

    return null;
  }

  /**
   * Try to extract a file path from the result
   */
  private extractFilePathFromResult(result: any): string | null {
    // Direct string path
    if (typeof result === 'string' && (result.includes('/') || result.includes('\\'))) {
      return result;
    }

    // Object with path field
    if (typeof result === 'object' && result) {
      const pathValue = result.path || result.filePath || result.screenshot || result.file || result.filename;
      if (typeof pathValue === 'string' && !pathValue.startsWith('data:')) {
        return pathValue;
      }
    }

    return null;
  }

  /**
   * Build the system prompt for the agent
   */
  private buildSystemPrompt(toolNames: string[]): string {
    // Get tool descriptions if available
    const tools = this.browserMCP.getTools();
    const toolDescriptions = toolNames.map(name => {
      const tool = tools[name];
      if (tool?.description) {
        return `- ${name}: ${tool.description}`;
      }
      return `- ${name}`;
    }).join('\n');

    return `You are a browser automation assistant using Browser MCP. You control the user's actual browser.

## Available Tools
${toolDescriptions}

## CRITICAL: Response Format
You MUST respond with EXACTLY ONE JSON code block. No other text before or after. Use this exact format:

\`\`\`json
{"action": "ACTION_TYPE", ...}
\`\`\`

### Action Types:

1. **Execute a tool** (use this to interact with the browser):
\`\`\`json
{"action": "execute_tool", "tool": "browser_navigate", "args": {"url": "https://example.com"}, "description": "Navigate to example.com"}
\`\`\`

2. **Get page snapshot** (IMPORTANT: use this to see what's on the page):
\`\`\`json
{"action": "execute_tool", "tool": "browser_snapshot", "args": {}, "description": "Get current page state"}
\`\`\`

3. **Click an element** (REQUIRED: both "element" and "ref"):
\`\`\`json
{"action": "execute_tool", "tool": "browser_click", "args": {"element": "Accept cookies button", "ref": "s2e47"}, "description": "Click accept button"}
\`\`\`

4. **Ask the user a question:**
\`\`\`json
{"action": "ask_user", "question": "What credentials should I use?"}
\`\`\`

5. **Complete the task:**
\`\`\`json
{"action": "complete", "message": "Successfully navigated to the page and took a screenshot"}
\`\`\`

6. **Report an error:**
\`\`\`json
{"action": "error", "message": "Could not find the login button"}
\`\`\`

## Tool Parameter Requirements
- **browser_click**: REQUIRES both "element" (description of what you're clicking) AND "ref" (element reference from snapshot)
- **browser_type**: REQUIRES "element", "ref", AND "text" (text to type)
- **browser_hover**: REQUIRES "element" AND "ref"
- **browser_select_option**: REQUIRES "element", "ref", AND "values" (array of values)

## Important Guidelines
1. ALWAYS start with browser_navigate to go to a URL
2. After navigation or any action, use browser_snapshot to see the current page state
3. The snapshot returns an accessibility tree - use the "ref" values (like "s2e47") to identify elements
4. For click/type/hover, you MUST include BOTH "element" (human description) AND "ref" (from snapshot)
5. Execute ONE tool at a time and wait for the result
6. For clicking cookie banners, look for buttons with text like "Accept", "OK", "I agree", "Consent"
7. Use browser_screenshot to capture the visible page for the user

## Common Workflow
1. browser_navigate to the URL
2. browser_wait with time=2 (wait 2 seconds for page to fully render)
3. browser_snapshot to see the page
4. Look for consent/cookie dialogs in the snapshot
5. browser_click with element="Accept cookies button" and ref="[ref from snapshot]"
6. browser_snapshot again to verify
7. browser_wait with time=1 (brief wait before screenshot)
8. browser_screenshot to capture the result

## Note on Screenshots
If browser_screenshot fails with "image readback failed", the user's browser tab may need to be visible and focused. Try browser_wait before screenshot.

REMEMBER: Always respond with a single JSON code block. No explanations outside the JSON.`;
  }

  /**
   * Parse the agent's response to determine the action
   */
  private parseAgentResponse(response: string): {
    type: 'execute_tool' | 'ask_user' | 'complete' | 'error' | 'unknown';
    toolName?: string;
    args?: Record<string, any>;
    description?: string;
    question?: string;
    message?: string;
  } {
    // Try to extract JSON from the response
    const jsonMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    let jsonStr = jsonMatch ? jsonMatch[1].trim() : response.trim();

    // Also try to find raw JSON object
    if (!jsonMatch) {
      const rawJsonMatch = response.match(/\{[\s\S]*\}/);
      if (rawJsonMatch) {
        jsonStr = rawJsonMatch[0];
      }
    }

    try {
      const parsed = JSON.parse(jsonStr);

      if (parsed.action === 'execute_tool' || parsed.action === 'tool') {
        return {
          type: 'execute_tool',
          toolName: parsed.tool || parsed.toolName,
          args: parsed.args || parsed.parameters || {},
          description: parsed.description,
        };
      }

      if (parsed.action === 'ask_user' || parsed.action === 'ask') {
        return {
          type: 'ask_user',
          question: parsed.question,
        };
      }

      if (parsed.action === 'complete' || parsed.action === 'done') {
        return {
          type: 'complete',
          message: parsed.message || parsed.summary,
        };
      }

      if (parsed.action === 'error' || parsed.action === 'fail') {
        return {
          type: 'error',
          message: parsed.message || parsed.error,
        };
      }
    } catch {
      // JSON parsing failed, try to infer from text
      const lowerResponse = response.toLowerCase();

      if (lowerResponse.includes('task completed') || lowerResponse.includes('successfully')) {
        return { type: 'complete', message: response };
      }

      if (lowerResponse.includes('?') && (lowerResponse.includes('would you') || lowerResponse.includes('should i') || lowerResponse.includes('do you want'))) {
        return { type: 'ask_user', question: response };
      }
    }

    return { type: 'unknown', message: response };
  }

  /**
   * Clean up old sessions (call periodically)
   */
  cleanupSessions(maxAgeMs: number = 3600000): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.updatedAt.getTime() > maxAgeMs) {
        this.sessions.delete(sessionId);
        this.logger.debug(`Cleaned up expired session: ${sessionId}`);
      }
    }
  }
}
