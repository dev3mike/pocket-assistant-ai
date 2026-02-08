/**
 * CODER SUB-AGENT – Handles coding tasks (clone, read/edit files, git, run commands, PR review).
 * Uses config.coder_model. Runs under data/coder/{project_folder}. Supports both synchronous
 * execution (returning results to main agent) and async background execution.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import {
  END,
  START,
  StateGraph,
  StateSchema,
  MessagesValue,
  ReducedValue,
  GraphNode,
  ConditionalEdgeRouter,
} from '@langchain/langgraph';
import * as z from 'zod';
import { CoderToolsService } from './coder-tools.service';
import { ProcessManagerService } from './process-manager.service';
import { IMessagingService, MESSAGING_SERVICE } from '../messaging/messaging.interface';
import { Inject } from '@nestjs/common';
import { UsageService } from '../usage/usage.service';
import { ConfigService } from '../config/config.service';
import { ModelFactoryService } from '../model/model-factory.service';
import { PromptService } from '../prompts/prompt.service';
import { TraceService } from '../logger/trace.service';
import { sanitize } from '../utils/input-sanitizer';

const DEFAULT_PROJECT_FOLDER = 'default';
// Reduced from 30 - if the agent needs more than 15 LLM calls, something is wrong
// This also limits auto-fix attempts since prompt tells it to stop on errors
const MAX_LLM_CALLS = 15;
// Threshold for sending progress updates to user (every N seconds)
const PROGRESS_UPDATE_INTERVAL_MS = 5000;

export interface RunningProcessInfo {
  id: string;
  command: string;
  port?: number;
  url?: string;
  status: 'starting' | 'running' | 'stopped' | 'failed';
  logs: string[];
}

export interface CoderTaskResult {
  success: boolean;
  task: string;
  projectFolder: string;
  summary: string;
  stepsCompleted: string[];
  error?: string;
  hasQuestion?: boolean;
  question?: string;
  runningProcesses?: RunningProcessInfo[];
}

@Injectable()
export class CoderAgentService implements OnModuleInit {
  private readonly logger = new Logger(CoderAgentService.name);
  private model: ChatOpenAI | null = null;
  private isInitialized = false;

  constructor(
    private readonly coderTools: CoderToolsService,
    private readonly processManager: ProcessManagerService,
    @Inject(MESSAGING_SERVICE)
    private readonly messagingService: IMessagingService,
    private readonly usageService: UsageService,
    private readonly configService: ConfigService,
    private readonly modelFactory: ModelFactoryService,
    private readonly promptService: PromptService,
    private readonly traceService: TraceService,
  ) { }

  async onModuleInit() {
    if (!process.env.OPENROUTER_API_KEY) {
      this.logger.warn('OPENROUTER_API_KEY not set, coder agent will not work');
      return;
    }
    // Use ModelFactory for centralized model management
    this.model = this.modelFactory.getModel('coder');
    this.isInitialized = true;
    this.logger.log('Coder agent initialized');
  }

  /**
   * Start the coder task in the background. Sends an immediate ack; progress and result are sent via messaging.
   * Returns a promise that resolves with the task result for callers that want to wait.
   */
  runInBackground(chatId: string, task: string, skipAckMessage = false): Promise<CoderTaskResult> {
    this.logger.log(`[${chatId}] Starting coder task in background: ${task.slice(0, 50)}...`);
    
    // Track the last status message ID so we can delete it before sending a new one
    let lastStatusMessageId: string | undefined;

    // Send start message
    this.messagingService
      .sendMessage(chatId, `🔧 **Coding task started**\n\n_${task.slice(0, 150)}${task.length > 150 ? '...' : ''}_`)
      .then((result) => {
        if (result.messageId) lastStatusMessageId = result.messageId;
        this.logger.debug(`[${chatId}] Sent coder start message`);
      })
      .catch((err) => this.logger.warn(`[${chatId}] Failed to send ack: ${err}`));

    // Track progress for updates to user
    let lastUpdateTime = 0; // Start at 0 to send first update immediately
    let recentSteps: string[] = [];
    let stepCount = 0;

    const onProgress = (msg: string) => {
      recentSteps.push(msg);
      stepCount++;
      this.logger.debug(`[${chatId}] Coder progress: ${msg}`);

      // Send progress update to user:
      // 1. Every PROGRESS_UPDATE_INTERVAL_MS (5 seconds)
      // 2. OR immediately for important events
      const now = Date.now();
      const isImportantEvent = 
        msg.startsWith('Running:') || 
        msg.startsWith('Starting') ||
        msg.includes('Error') || 
        msg.includes('error') || 
        msg.includes('Written') ||
        msg.includes('Cloning') ||
        msg.includes('Installing') ||
        msg.includes('Command completed') ||
        msg.includes('Command failed') ||
        msg.startsWith('Using project') ||
        msg.startsWith('⚠️');
      const timeForUpdate = now - lastUpdateTime >= PROGRESS_UPDATE_INTERVAL_MS;
      
      if (isImportantEvent || timeForUpdate) {
        lastUpdateTime = now;
        
        // Delete previous status message before sending new one
        if (lastStatusMessageId && this.messagingService.deleteMessage) {
          this.messagingService.deleteMessage(chatId, lastStatusMessageId).catch(() => {});
        }
        
        // Send progress with step count and recent steps
        const stepsDisplay = recentSteps.slice(-4).map(s => `• ${s}`).join('\n');
        const progressMsg = `🔄 **Coding...** (step ${stepCount})\n\n${stepsDisplay}`;
        this.messagingService.sendMessage(chatId, progressMsg)
          .then((result) => {
            if (result.messageId) lastStatusMessageId = result.messageId;
            this.logger.debug(`[${chatId}] Sent progress update`);
          })
          .catch((err) => this.logger.warn(`[${chatId}] Failed to send progress: ${err}`));
        recentSteps = []; // Reset after sending
      }
    };

    return this.run(chatId, task, onProgress)
      .then((result) => {
        // Delete last status message before sending final result
        if (lastStatusMessageId && this.messagingService.deleteMessage) {
          this.messagingService.deleteMessage(chatId, lastStatusMessageId).catch(() => {});
        }
        // Send final result to user
        const resultMsg = this.formatResultForUser(result);
        this.messagingService.sendMessage(chatId, resultMsg).catch(() => { });
        return result;
      })
      .catch((error: unknown) => {
        // Delete last status message before sending error
        if (lastStatusMessageId && this.messagingService.deleteMessage) {
          this.messagingService.deleteMessage(chatId, lastStatusMessageId).catch(() => {});
        }
        const errMsg = this.toErrorMessage(error);
        this.logger.error(`Coder task failed for ${chatId}: ${errMsg}`);
        this.messagingService.sendMessage(chatId, `❌ Coder task failed: ${errMsg}`).catch(() => { });
        return {
          success: false,
          task,
          projectFolder: 'unknown',
          summary: `Task failed: ${errMsg}`,
          stepsCompleted: recentSteps,
          error: errMsg,
        };
      });
  }

  /**
   * Format task result for display to user via Telegram
   */
  private formatResultForUser(result: CoderTaskResult): string {
    if (result.success) {
      let msg = `✅ **Coding task completed**\n\n`;
      msg += `**Project:** ${result.projectFolder}\n`;

      if (result.stepsCompleted.length > 0) {
        msg += `\n**Steps (${result.stepsCompleted.length}):**\n`;
        // Show last 5 steps
        const recentSteps = result.stepsCompleted.slice(-5);
        for (const step of recentSteps) {
          msg += `• ${step}\n`;
        }
        if (result.stepsCompleted.length > 5) {
          msg += `_... and ${result.stepsCompleted.length - 5} more_\n`;
        }
      }

      msg += `\n**Summary:**\n${result.summary.slice(0, 1000)}${result.summary.length > 1000 ? '...' : ''}`;

      if (result.runningProcesses && result.runningProcesses.length > 0) {
        msg += `\n\n**Running Processes:**\n`;
        for (const proc of result.runningProcesses) {
          const portInfo = proc.port ? ` (port ${proc.port})` : '';
          msg += `• ${proc.command}${portInfo} [${proc.status}]\n`;
        }
      }

      return msg;
    } else {
      let msg = `❌ **Coding task failed**\n\n`;
      msg += `**Project:** ${result.projectFolder}\n`;
      if (result.error) {
        msg += `**Error:** ${result.error}\n`;
      }
      if (result.stepsCompleted.length > 0) {
        msg += `\n**Steps before failure:**\n`;
        for (const step of result.stepsCompleted.slice(-3)) {
          msg += `• ${step}\n`;
        }
      }
      return msg;
    }
  }

  private toErrorMessage(e: unknown): string {
    if (e == null) return 'Unknown error';
    if (e instanceof Error) return e.message;
    if (typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
    return String(e);
  }

  /**
   * Use LLM to intelligently determine the project folder for a task.
   * Given the current folder (if any) and the task, the LLM decides whether to:
   * - Continue in the current folder
   * - Switch to a different existing folder
   * - Create a new folder
   *
   * This approach works in any language and handles nuanced requests.
   */
  private async resolveProjectFolder(chatId: string, task: string): Promise<string> {
    if (!this.model) return DEFAULT_PROJECT_FOLDER;

    const currentFolder = this.configService.getCoderActiveFolder(chatId);

    try {
      const systemPrompt = `You are a project folder resolver. Given a coding task and the current active project folder (if any), determine which project folder should be used.

RESPOND WITH ONLY ONE LINE in this exact format:
FOLDER: <folder-name>

Rules:
1. If the task asks to CREATE a new project, initialize something new, clone a repo, or explicitly names a new project → use that new project name
2. If the task mentions working on a SPECIFIC project by name → use that project name
3. If the task is clearly about CONTINUING work on the current project (bug fixes, adding features, editing files) → use the current folder
4. If there's no current folder and the task is generic → use "default"

Folder name format: lowercase letters, numbers, hyphens, or underscores only (e.g., my-app, test-api, ai-daily)

Examples:
- Task: "create a new react project called my-app" → FOLDER: my-app
- Task: "name it ai-daily" with any context about creating → FOLDER: ai-daily
- Task: "fix the bug in the login component" (current: my-app) → FOLDER: my-app
- Task: "clone https://github.com/user/cool-project" → FOLDER: cool-project
- Task: "switch to the test-api project" → FOLDER: test-api
- Task: "add a README file" (current: my-app) → FOLDER: my-app
- Task: "بساز یک پروژه جدید به نام shop-app" → FOLDER: shop-app`;

      const userPrompt = currentFolder
        ? `Current active folder: "${currentFolder}"\n\nTask: ${task.slice(0, 1500)}`
        : `No current active folder.\n\nTask: ${task.slice(0, 1500)}`;

      const response = await this.model.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(userPrompt),
      ]);

      if (AIMessage.isInstance(response) && chatId) {
        this.usageService.recordUsageFromResponse(chatId, response);
      }

      const raw = typeof response.content === 'string' ? response.content : String(response.content ?? '');

      // Extract folder name from "FOLDER: xxx" format
      const folderMatch = raw.match(/FOLDER:\s*([a-z0-9_.-]+)/i);
      let folder = folderMatch?.[1]?.toLowerCase();

      // Fallback: try to extract any valid folder name from the response
      if (!folder) {
        const anyMatch = raw.match(/[a-z][a-z0-9_.-]*/gi);
        folder = anyMatch?.find((m) => m.length > 1 && m !== 'folder')?.toLowerCase();
      }

      folder = folder || currentFolder || DEFAULT_PROJECT_FOLDER;

      // Save the resolved folder
      this.configService.setCoderActiveFolder(chatId, folder).catch(() => { });
      this.logger.debug(`Resolved project folder: ${folder} (was: ${currentFolder || 'none'})`);

      return folder;
    } catch (e) {
      this.logger.warn(`LLM folder resolution failed: ${e}`);
      const fallback = currentFolder || DEFAULT_PROJECT_FOLDER;
      this.configService.setCoderActiveFolder(chatId, fallback).catch(() => { });
      return fallback;
    }
  }

  /**
   * Execute a coder task synchronously and return the result.
   * This allows the main agent to receive the result and respond accordingly.
   * Also sends progress updates to the user via messaging.
   */
  async executeTask(chatId: string, task: string): Promise<CoderTaskResult> {
    const stepsCompleted: string[] = [];
    let lastUpdateTime = 0; // Start at 0 to send first update immediately
    let recentSteps: string[] = [];
    let stepCount = 0;
    
    // Track the last status message ID so we can delete it before sending a new one
    let lastStatusMessageId: string | undefined;

    // Send initial message
    const startResult = await this.messagingService
      .sendMessage(chatId, `🔧 **Coding task started**\n\n_${task.slice(0, 150)}${task.length > 150 ? '...' : ''}_`)
      .catch((err) => {
        this.logger.warn(`[${chatId}] Failed to send start message: ${err}`);
        return { success: false } as { success: boolean; messageId?: string };
      });
    if (startResult.messageId) lastStatusMessageId = startResult.messageId;

    const onProgress = (message: string) => {
      stepsCompleted.push(message);
      recentSteps.push(message);
      stepCount++;
      this.logger.debug(`[${chatId}] Coder progress: ${message}`);

      // Send progress updates to user
      const now = Date.now();
      const isImportantEvent = 
        message.startsWith('Running:') || 
        message.startsWith('Starting') ||
        message.includes('Error') || 
        message.includes('error') || 
        message.includes('Written') ||
        message.includes('Cloning') ||
        message.includes('Installing') ||
        message.includes('Command completed') ||
        message.includes('Command failed') ||
        message.startsWith('Using project') ||
        message.startsWith('⚠️');
      const timeForUpdate = now - lastUpdateTime >= PROGRESS_UPDATE_INTERVAL_MS;
      
      if (isImportantEvent || timeForUpdate) {
        lastUpdateTime = now;
        
        // Delete previous status message before sending new one
        if (lastStatusMessageId && this.messagingService.deleteMessage) {
          this.messagingService.deleteMessage(chatId, lastStatusMessageId).catch(() => {});
        }
        
        const stepsDisplay = recentSteps.slice(-4).map(s => `• ${s}`).join('\n');
        const progressMsg = `🔄 **Coding...** (step ${stepCount})\n\n${stepsDisplay}`;
        this.messagingService.sendMessage(chatId, progressMsg)
          .then((result) => {
            if (result.messageId) lastStatusMessageId = result.messageId;
            this.logger.debug(`[${chatId}] Sent progress update`);
          })
          .catch((err) => this.logger.warn(`[${chatId}] Failed to send progress: ${err}`));
        recentSteps = [];
      }
    };

    try {
      const result = await this.run(chatId, task, onProgress);
      // Delete last status message - final result will be sent by main agent
      if (lastStatusMessageId && this.messagingService.deleteMessage) {
        this.messagingService.deleteMessage(chatId, lastStatusMessageId).catch(() => {});
      }
      return result;
    } catch (error) {
      // Delete last status message before returning error
      if (lastStatusMessageId && this.messagingService.deleteMessage) {
        this.messagingService.deleteMessage(chatId, lastStatusMessageId).catch(() => {});
      }
      const errMsg = this.toErrorMessage(error);
      return {
        success: false,
        task,
        projectFolder: 'unknown',
        summary: `Task failed: ${errMsg}`,
        stepsCompleted,
        error: errMsg,
      };
    }
  }

  /**
   * Run the coder agent with progress callback.
   * Returns a structured result for the main agent.
   */
  async run(
    chatId: string,
    task: string,
    onProgress?: (message: string) => void,
  ): Promise<CoderTaskResult> {
    const stepsCompleted: string[] = [];
    const traceId = this.traceService.startTrace(chatId).traceId;
    const rootSpanId = this.traceService.startSpan('coder_task', traceId, undefined, { task });

    if (!this.isInitialized || !this.model) {
      const errorMsg = 'Coder agent is not initialized (missing OPENROUTER_API_KEY).';
      onProgress?.(errorMsg);
      this.traceService.endSpanWithError(rootSpanId, errorMsg);
      return {
        success: false,
        task,
        projectFolder: 'unknown',
        summary: errorMsg,
        stepsCompleted,
        error: errorMsg,
      };
    }

    // Sanitize task input
    const sanitizedTask = sanitize(task, 3000);

    const projectFolder = await this.resolveProjectFolder(chatId, sanitizedTask);
    onProgress?.(`Using project folder: ${projectFolder}`);
    stepsCompleted.push(`Using project folder: ${projectFolder}`);

    const toolsByName = this.coderTools.getTools(projectFolder, (msg) => {
      onProgress?.(msg);
      stepsCompleted.push(msg);
    });
    const tools = Object.values(toolsByName);
    const modelWithTools = this.model.bindTools(tools);

    // Get system prompt from PromptService (supports hot-reload)
    const systemPrompt = this.promptService.buildCoderAgentPrompt(projectFolder);

    const traceService = this.traceService;

    // Simple state - just track messages and LLM calls
    const MessagesState = new StateSchema({
      messages: MessagesValue,
      llmCalls: new ReducedValue(z.number().default(0), { reducer: (x, y) => x + y }),
    });

    const llmCall: GraphNode<typeof MessagesState> = async (state) => {
      const llmSpanId = traceService.startSpan('coder_llm_call', traceId, rootSpanId);
      const response = await modelWithTools.invoke([
        new SystemMessage(systemPrompt),
        ...state.messages,
      ]);
      if (AIMessage.isInstance(response) && chatId) {
        this.usageService.recordUsageFromResponse(chatId, response);
      }
      traceService.endSpan(llmSpanId);
      return { messages: [response], llmCalls: 1 };
    };

    const toolNode: GraphNode<typeof MessagesState> = async (state) => {
      const lastMessage = state.messages.at(-1);
      if (!lastMessage || !AIMessage.isInstance(lastMessage) || !lastMessage.tool_calls?.length) {
        return { messages: [] };
      }
      const results: ToolMessage[] = [];

      for (const toolCall of lastMessage.tool_calls) {
        const toolSpanId = traceService.startSpan(`coder_tool:${toolCall.name}`, traceId, rootSpanId);
        const tool = toolsByName[toolCall.name];
        if (!tool) {
          traceService.endSpanWithError(toolSpanId, `Tool not found: ${toolCall.name}`);
          results.push(
            new ToolMessage({
              tool_call_id: toolCall.id!,
              content: `Error: Tool "${toolCall.name}" not found`,
            }),
          );
          continue;
        }
        try {
          const observation = await tool.invoke(toolCall);
          const stepMsg = `Done: ${toolCall.name}`;
          onProgress?.(stepMsg);
          stepsCompleted.push(stepMsg);
          traceService.endSpan(toolSpanId);
          const content = Array.isArray(observation) ? observation[0] : observation;
          const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
          results.push(
            new ToolMessage({
              tool_call_id: toolCall.id!,
              content: contentStr,
            }),
          );
        } catch (error: unknown) {
          const errMsg = this.toErrorMessage(error);
          const stepMsg = `Error in ${toolCall.name}: ${errMsg}`;
          onProgress?.(stepMsg);
          stepsCompleted.push(stepMsg);
          traceService.endSpanWithError(toolSpanId, errMsg);
          results.push(
            new ToolMessage({
              tool_call_id: toolCall.id!,
              content: `Error: ${errMsg}`,
            }),
          );
        }
      }

      return { messages: results };
    };

    const shouldContinue: ConditionalEdgeRouter<typeof MessagesState, Record<string, any>> = (state) => {
      const lastMessage = state.messages.at(-1);
      if (!lastMessage || !AIMessage.isInstance(lastMessage)) return END;
      if (lastMessage.tool_calls?.length) return 'toolNode';
      if ((state.llmCalls ?? 0) >= MAX_LLM_CALLS) return END;
      return END;
    };

    const graph = new StateGraph(MessagesState)
      .addNode('llmCall', llmCall)
      .addNode('toolNode', toolNode)
      .addEdge(START, 'llmCall')
      .addConditionalEdges('llmCall', shouldContinue, ['toolNode', END])
      .addEdge('toolNode', 'llmCall')
      .compile();

    try {
      const result = await graph.invoke({
        messages: [new HumanMessage(sanitizedTask)],
        llmCalls: 0,
      });

      const finalContent = result.messages?.at(-1)?.content;
      const summary = typeof finalContent === 'string' ? finalContent : (finalContent ? JSON.stringify(finalContent) : 'Done.');
      onProgress?.(summary);

      // Check if the response is asking a question (coder agent needs clarification)
      const hasQuestion = this.responseContainsQuestion(summary);

      // Collect running processes info
      const runningProcesses = this.collectRunningProcesses();

      this.traceService.endSpan(rootSpanId, { stepsCompleted: stepsCompleted.length });

      return {
        success: true,
        task,
        projectFolder,
        summary,
        stepsCompleted,
        hasQuestion,
        question: hasQuestion ? summary : undefined,
        runningProcesses: runningProcesses.length > 0 ? runningProcesses : undefined,
      };
    } catch (error) {
      const errMsg = this.toErrorMessage(error);
      this.traceService.endSpanWithError(rootSpanId, errMsg);

      // Still collect running processes even on error
      const runningProcesses = this.collectRunningProcesses();

      return {
        success: false,
        task,
        projectFolder,
        summary: `Task failed: ${errMsg}`,
        stepsCompleted,
        error: errMsg,
        runningProcesses: runningProcesses.length > 0 ? runningProcesses : undefined,
      };
    }
  }

  /**
   * Collect info about all running processes for the result
   */
  private collectRunningProcesses(): RunningProcessInfo[] {
    return this.processManager.listProcesses().map((p) => ({
      id: p.id,
      command: p.command,
      port: p.port,
      url: p.url,
      status: p.status,
      logs: p.logs.slice(-20), // Last 20 log lines - main agent can read and understand errors
    }));
  }

  /**
   * Check if the coder agent's response contains a question for the user.
   */
  private responseContainsQuestion(response: string): boolean {
    const questionPatterns = [
      /which .*\?/i,
      /what .*\?/i,
      /could you .*\?/i,
      /can you .*\?/i,
      /please (provide|specify|clarify)/i,
      /i need (more information|to know|clarification)/i,
    ];
    return questionPatterns.some((pattern) => pattern.test(response));
  }
}
