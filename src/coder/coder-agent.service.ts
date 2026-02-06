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
import { IMessagingService, MESSAGING_SERVICE } from '../messaging/messaging.interface';
import { Inject } from '@nestjs/common';
import { UsageService } from '../usage/usage.service';
import { ConfigService } from '../config/config.service';
import { ModelFactoryService } from '../model/model-factory.service';
import { PromptService } from '../prompts/prompt.service';
import { TraceService } from '../logger/trace.service';
import { sanitize } from '../utils/input-sanitizer';

const DEFAULT_PROJECT_FOLDER = 'default';
const MAX_LLM_CALLS = 30;

export interface CoderTaskResult {
  success: boolean;
  task: string;
  projectFolder: string;
  summary: string;
  stepsCompleted: string[];
  error?: string;
  hasQuestion?: boolean;
  question?: string;
}

@Injectable()
export class CoderAgentService implements OnModuleInit {
  private readonly logger = new Logger(CoderAgentService.name);
  private model: ChatOpenAI | null = null;
  private isInitialized = false;

  constructor(
    private readonly coderTools: CoderToolsService,
    @Inject(MESSAGING_SERVICE)
    private readonly messagingService: IMessagingService,
    private readonly usageService: UsageService,
    private readonly configService: ConfigService,
    private readonly modelFactory: ModelFactoryService,
    private readonly promptService: PromptService,
    private readonly traceService: TraceService,
  ) {}

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
   */
  runInBackground(chatId: string, task: string): void {
    this.messagingService
      .sendMessage(chatId, "I've started your coding task. I'll send you updates here as I go.")
      .catch((err) => this.logger.warn(`Failed to send ack to ${chatId}: ${err}`));

    Promise.resolve()
      .then(() => this.run(chatId, task, (msg) => this.messagingService.sendMessage(chatId, msg).then(() => {})))
      .catch((error: unknown) => {
        const errMsg = this.toErrorMessage(error);
        this.logger.error(`Coder task failed for ${chatId}: ${errMsg}`);
        this.messagingService.sendMessage(chatId, `Coder task failed: ${errMsg}`).catch(() => {});
      });
  }

  private toErrorMessage(e: unknown): string {
    if (e == null) return 'Unknown error';
    if (e instanceof Error) return e.message;
    if (typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
    return String(e);
  }

  /**
   * Return true if the task clearly asks for a new/different project (clone URL, "new folder", etc.).
   */
  private taskAsksForNewProject(task: string): boolean {
    const lower = task.toLowerCase().trim();
    if (/clone\s+https?:\/\//i.test(lower) || /clone\s+[^\s]+\/[^\s]+/.test(lower)) return true;
    if (/\bnew\s+folder\b|\bnew\s+project\b|\bin\s+a\s+new\s+folder\b|\bdifferent\s+project\b|\bstart\s+(a\s+)?new\b|\bfresh\s+project\b/i.test(lower)) return true;
    return false;
  }

  /**
   * Ask the LLM for the project folder name under data/coder/ based on the user task.
   * Returns a safe folder name (alphanumeric, hyphen, underscore only); falls back to "default" on error.
   */
  private async askLLMForProjectFolder(task: string, chatId?: string): Promise<string> {
    if (!this.model) return DEFAULT_PROJECT_FOLDER;
    try {
      const response = await this.model.invoke([
        new SystemMessage(
          `You are a helper. Given the user's coding task, output ONLY the name of the project folder to use under data/coder/.

Rules:
- Output a single folder name: lowercase letters, numbers, hyphens, or underscores (e.g. default, my-app, test-api, express-server).
- If the task mentions cloning a repo, use the repo name as the folder (e.g. github.com/foo/test-api -> test-api).
- If the task mentions a project or folder name, use that.
- If unclear or generic, use "default".
- No explanation, no quotes, no path – just the folder name.`,
        ),
        new HumanMessage(task.slice(0, 1500)),
      ]);
      const raw = typeof response.content === 'string' ? response.content : String(response.content ?? '');
      const trimmed = raw.trim();
      const tokens = trimmed.split(/\s+/);
      const folderToken = tokens.find((t) => /^[a-z0-9_.-]+$/i.test(t) && t.length > 1);
      const fromMatch = trimmed.match(/[a-z0-9][a-z0-9_.-]*/gi);
      const bestMatch = fromMatch?.sort((a, b) => b.length - a.length)[0];
      const safe = (folderToken || bestMatch || DEFAULT_PROJECT_FOLDER).toLowerCase();
      if (AIMessage.isInstance(response) && chatId) {
        this.usageService.recordUsageFromResponse(chatId, response);
      }
      return safe || DEFAULT_PROJECT_FOLDER;
    } catch (e) {
      this.logger.warn(`LLM folder resolution failed: ${e}`);
      return DEFAULT_PROJECT_FOLDER;
    }
  }

  /**
   * Resolve project folder: use stored folder for this chat unless the task asks for a new project,
   * otherwise ask the LLM for the folder name based on the task.
   */
  private async resolveProjectFolder(chatId: string, task: string): Promise<string> {
    let folder: string;

    if (this.taskAsksForNewProject(task)) {
      folder = await this.askLLMForProjectFolder(task, chatId);
    } else {
      const stored = this.configService.getCoderActiveFolder(chatId);
      if (stored) folder = stored;
      else folder = await this.askLLMForProjectFolder(task, chatId);
    }

    this.configService.setCoderActiveFolder(chatId, folder).catch(() => {});
    return folder;
  }

  /**
   * Execute a coder task synchronously and return the result.
   * This allows the main agent to receive the result and respond accordingly.
   */
  async executeTask(chatId: string, task: string): Promise<CoderTaskResult> {
    const stepsCompleted: string[] = [];

    const onProgress = (message: string) => {
      stepsCompleted.push(message);
      this.logger.debug(`[${chatId}] Coder progress: ${message}`);
    };

    try {
      const result = await this.run(chatId, task, onProgress);
      return result;
    } catch (error) {
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
          results.push(
            new ToolMessage({
              tool_call_id: toolCall.id!,
              content: typeof content === 'string' ? content : JSON.stringify(content),
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

      this.traceService.endSpan(rootSpanId, { stepsCompleted: stepsCompleted.length });

      return {
        success: true,
        task,
        projectFolder,
        summary,
        stepsCompleted,
        hasQuestion,
        question: hasQuestion ? summary : undefined,
      };
    } catch (error) {
      const errMsg = this.toErrorMessage(error);
      this.traceService.endSpanWithError(rootSpanId, errMsg);
      return {
        success: false,
        task,
        projectFolder,
        summary: `Task failed: ${errMsg}`,
        stepsCompleted,
        error: errMsg,
      };
    }
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
