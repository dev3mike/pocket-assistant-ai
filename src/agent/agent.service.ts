/**
 * MAIN AGENT – Orchestrates all user conversations and tool use.
 * Runs a LangGraph loop: receives messages (from Telegram or Scheduler), loads memory,
 * calls the LLM with tools (getProfile, createSchedule, executeBrowserTask, etc.),
 * executes tool calls, then returns the final reply. When the user asks for browser
 * tasks (e.g. "go to x.com"), it calls the executeBrowserTask tool, which delegates
 * to the Browser Agent (sub-agent). Entry points: processMessage() from Telegram
 * and from Scheduler when a job runs.
 */
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import {
  ConditionalEdgeRouter,
  END,
  GraphNode,
  MessagesValue,
  ReducedValue,
  START,
  StateGraph,
  StateSchema,
} from '@langchain/langgraph';
import * as z from 'zod';
import * as fs from 'fs';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, BaseMessage } from '@langchain/core/messages';
import { ConfigService } from '../config/config.service';
import { AgentLoggerService, LogEvent } from '../logger/agent-logger.service';
import { TraceService, TraceContext } from '../logger/trace.service';
import { ToolsService } from './tools.service';
import { SoulService } from '../soul/soul.service';
import { MemoryService, FileAttachment } from '../memory/memory.service';
import { UsageService } from '../usage/usage.service';
import { ModelFactoryService } from '../model/model-factory.service';
import { PromptService } from '../prompts/prompt.service';
import { ProgressUpdate } from '../messaging/messaging.interface';
import { sanitize } from '../utils/input-sanitizer';

// Attached file info for multi-modal messages
export interface AttachedFile {
  id: string;
  path: string;
  mimeType: string;
}


@Injectable()
export class AgentService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentService.name);

  private model: ChatOpenAI;
  private mcpClient: MultiServerMCPClient | null = null;
  private zapierTools: Record<string, any> = {};
  private isInitialized = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly agentLogger: AgentLoggerService,
    private readonly traceService: TraceService,
    private readonly toolsService: ToolsService,
    private readonly soulService: SoulService,
    private readonly memoryService: MemoryService,
    private readonly usageService: UsageService,
    private readonly modelFactory: ModelFactoryService,
    private readonly promptService: PromptService,
  ) { }

  async onModuleInit() {
    await this.initialize();
  }

  async onModuleDestroy() {
    await this.cleanup();
  }

  private async initialize(): Promise<void> {
    this.agentLogger.info(LogEvent.AGENT_INIT, 'Initializing agent service');

    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error('OPENROUTER_API_KEY environment variable is not set');
    }

    // Use ModelFactory for centralized model management
    this.model = this.modelFactory.getModel('main');

    // Try to load Zapier tools if configured (these are shared across all users)
    if (process.env.ZAPIER_MCP_TOKEN) {
      await this.loadZapierTools();
    } else {
      this.logger.warn('ZAPIER_MCP_TOKEN not set, skipping Zapier tools');
    }

    this.isInitialized = true;

    const baseToolCount = Object.keys(this.toolsService.getLocalTools()).length;
    const zapierToolCount = Object.keys(this.zapierTools).length;

    this.agentLogger.info(LogEvent.AGENT_READY, 'Agent service initialized successfully', {
      data: { baseTools: baseToolCount, zapierTools: zapierToolCount },
    });
    this.logger.log(`Agent service initialized with ${baseToolCount} base tools and ${zapierToolCount} Zapier tools`);
  }

  private async loadZapierTools(): Promise<void> {
    const mcpUrl = `https://mcp.zapier.com/api/v1/connect?token=${process.env.ZAPIER_MCP_TOKEN}`;

    this.agentLogger.info(LogEvent.MCP_CONNECT, 'Connecting to Zapier MCP');

    this.mcpClient = new MultiServerMCPClient({
      zapier: {
        transport: 'http',
        url: mcpUrl,
      },
    });

    try {
      const zapierTools = await this.withTimeout(this.mcpClient.getTools(), 15000, 'MCP getTools');

      this.agentLogger.info(LogEvent.MCP_TOOLS_LOADED, `Loaded ${zapierTools.length} Zapier tools`, {
        data: { tools: zapierTools.map((t) => t.name) },
      });

      for (const zapierTool of zapierTools) {
        this.zapierTools[zapierTool.name] = zapierTool;
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.agentLogger.warn(LogEvent.MCP_FAILED, `Could not load Zapier tools: ${errorMsg}`);
      this.logger.warn(`Could not load Zapier tools: ${errorMsg}`);
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, operation: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`${operation} timed out after ${ms}ms`)), ms),
      ),
    ]);
  }

  /**
   * Get tools for a specific chat (includes per-user tools)
   */
  private getToolsForChat(chatId: string): Record<string, any> {
    // Get tools with chat context (includes profile update tools)
    const localTools = this.toolsService.getToolsForChat(chatId);

    // Combine with Zapier tools
    return {
      ...localTools,
      ...this.zapierTools,
    };
  }

  /**
   * Build the system prompt with soul context for a specific user.
   * Injects current date/time so the agent always has it without a separate tool.
   */
  private buildSystemPrompt(chatId: string): string {
    const soulContext = this.soulService.getSoulContext(chatId);
    const base = this.promptService.buildMainAgentPrompt(soulContext || undefined);
    const currentDateTime = new Date().toISOString();
    return `${base}\n\n**Current date and time (ISO):** ${currentDateTime}`;
  }

  /**
   * Build and run the agent for a specific conversation
   */
  private buildAgent(
    chatId: string,
    traceId: string,
    rootSpanId: string,
    onProgress?: (update: ProgressUpdate) => void,
  ) {
    // Get tools specific to this chat
    const toolsByName = this.getToolsForChat(chatId);
    const tools = Object.values(toolsByName);

    // Bind tools to model for this request
    const modelWithTools = this.model.bindTools(tools);

    const agentLogger = this.agentLogger;
    const traceService = this.traceService;
    const usageService = this.usageService;
    const systemPrompt = this.buildSystemPrompt(chatId);
    const modelName = this.modelFactory.getModelNameForType('main');

    const MessagesState = new StateSchema({
      messages: MessagesValue,
      traceId: new ReducedValue(z.string(), { reducer: (_, y) => y }),
      rootSpanId: new ReducedValue(z.string(), { reducer: (_, y) => y }),
      llmCalls: new ReducedValue(z.number().default(0), {
        reducer: (x, y) => x + y,
      }),
      inputTokens: new ReducedValue(z.number().default(0), {
        reducer: (x, y) => x + y,
      }),
      outputTokens: new ReducedValue(z.number().default(0), {
        reducer: (x, y) => x + y,
      }),
    });

    const llmCall: GraphNode<typeof MessagesState> = async (state) => {
      const spanId = traceService.startSpan('llm_call', state.traceId, state.rootSpanId, {
        callNumber: state.llmCalls + 1,
      });

      agentLogger.info(LogEvent.LLM_INVOKE, `Invoking LLM (call #${state.llmCalls + 1})`, {
        chatId,
        data: { traceId: state.traceId.slice(0, 8) },
      });

      // Emit thinking progress (for subsequent calls after the first)
      if (state.llmCalls > 0) {
        onProgress?.({ type: 'thinking', message: 'Thinking...', timestamp: new Date() });
      }

      // Prepare messages for LLM call
      const llmInput = [new SystemMessage(systemPrompt), ...state.messages];
      const response = await modelWithTools.invoke(llmInput);

      // Extract token usage from response using helper
      let inTokens = 0;
      let outTokens = 0;

      if (AIMessage.isInstance(response)) {
        const usage = usageService.extractUsageFromResponse(response);
        inTokens = usage.inputTokens;
        outTokens = usage.outputTokens;

        // Record LLM generation in Langfuse for proper observability
        traceService.recordGeneration(state.traceId, {
          name: `llm_call_${state.llmCalls + 1}`,
          model: modelName,
          input: llmInput.map((m) => ({ role: m._getType(), content: m.content })),
          output: { role: 'assistant', content: response.content, tool_calls: response.tool_calls },
          usage: {
            promptTokens: inTokens,
            completionTokens: outTokens,
            totalTokens: inTokens + outTokens,
          },
          metadata: {
            callNumber: state.llmCalls + 1,
            hasToolCalls: !!response.tool_calls?.length,
          },
        });
      }

      if (AIMessage.isInstance(response)) {
        if (response.tool_calls?.length) {
          agentLogger.info(
            LogEvent.TOOL_CALL_REQUESTED,
            `LLM requested ${response.tool_calls.length} tool call(s)`,
            {
              chatId,
              data: {
                traceId: state.traceId.slice(0, 8),
                toolCalls: response.tool_calls.map((tc) => ({ name: tc.name, args: tc.args })),
              },
            },
          );
        } else {
          agentLogger.info(LogEvent.LLM_RESPONSE, 'LLM generated response', {
            chatId,
            data: {
              traceId: state.traceId.slice(0, 8),
              contentPreview: String(response.content).slice(0, 100),
            },
          });
        }
      }

      traceService.endSpan(spanId, { inputTokens: inTokens, outputTokens: outTokens });

      return {
        messages: [response],
        llmCalls: 1,
        inputTokens: inTokens,
        outputTokens: outTokens,
      };
    };

    const toolNode: GraphNode<typeof MessagesState> = async (state) => {
      const lastMessage = state.messages.at(-1);

      if (!lastMessage || !AIMessage.isInstance(lastMessage)) {
        return { messages: [] };
      }

      const results: ToolMessage[] = [];

      for (const toolCall of lastMessage.tool_calls ?? []) {
        const toolSpanId = traceService.startSpan(`tool:${toolCall.name}`, state.traceId, state.rootSpanId, {
          toolName: toolCall.name,
          args: toolCall.args,
        });

        agentLogger.info(LogEvent.TOOL_EXECUTING, `Executing tool: ${toolCall.name}`, {
          chatId,
          data: { traceId: state.traceId.slice(0, 8), args: toolCall.args },
        });

        // Emit tool start progress
        onProgress?.({
          type: 'tool_start',
          message: `Using ${toolCall.name}...`,
          toolName: toolCall.name,
          timestamp: new Date(),
        });

        const selectedTool = toolsByName[toolCall.name];

        if (!selectedTool) {
          agentLogger.error(LogEvent.TOOL_ERROR, `Tool not found: ${toolCall.name}`, { chatId });
          traceService.endSpanWithError(toolSpanId, `Tool not found: ${toolCall.name}`);
          onProgress?.({
            type: 'error',
            message: `Tool "${toolCall.name}" not found`,
            toolName: toolCall.name,
            timestamp: new Date(),
          });
          results.push(
            new ToolMessage({
              tool_call_id: toolCall.id!,
              content: `Error: Tool "${toolCall.name}" not found`,
            }),
          );
          continue;
        }

        try {
          const observation = await selectedTool.invoke(toolCall);
          agentLogger.info(LogEvent.TOOL_RESULT, `Tool ${toolCall.name} completed`, {
            chatId,
            data: { traceId: state.traceId.slice(0, 8), result: String(observation).slice(0, 200) },
          });
          traceService.endSpan(toolSpanId, { resultPreview: String(observation).slice(0, 200) });

          // Emit tool complete progress
          onProgress?.({
            type: 'tool_complete',
            message: `${toolCall.name} completed`,
            toolName: toolCall.name,
            timestamp: new Date(),
          });

          results.push(observation);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          agentLogger.error(LogEvent.TOOL_ERROR, `Tool ${toolCall.name} failed: ${errorMessage}`, {
            chatId,
          });
          traceService.endSpanWithError(toolSpanId, errorMessage);

          // Emit tool error progress
          onProgress?.({
            type: 'error',
            message: `${toolCall.name} failed`,
            toolName: toolCall.name,
            timestamp: new Date(),
          });

          results.push(
            new ToolMessage({
              tool_call_id: toolCall.id!,
              content: `Error executing tool: ${errorMessage}`,
            }),
          );
        }
      }

      return { messages: results };
    };

    const shouldContinue: ConditionalEdgeRouter<typeof MessagesState, Record<string, any>> = (state) => {
      const lastMessage = state.messages.at(-1);

      if (!lastMessage || !AIMessage.isInstance(lastMessage)) {
        agentLogger.debug(LogEvent.ROUTING, 'No AI message, ending', { chatId });
        return END;
      }

      if (lastMessage.tool_calls?.length) {
        agentLogger.debug(LogEvent.ROUTING, 'Tool calls pending, routing to toolNode', { chatId });
        return 'toolNode';
      }

      agentLogger.debug(LogEvent.ROUTING, 'No more tool calls, ending', { chatId });
      return END;
    };

    return new StateGraph(MessagesState)
      .addNode('llmCall', llmCall)
      .addNode('toolNode', toolNode)
      .addEdge(START, 'llmCall')
      .addConditionalEdges('llmCall', shouldContinue, ['toolNode', END])
      .addEdge('toolNode', 'llmCall')
      .compile();
  }

  async processMessage(
    chatId: string,
    userMessage: string,
    onProgress?: (update: ProgressUpdate) => void,
    attachedFiles?: AttachedFile[],
  ): Promise<{ text: string; screenshots: string[] }> {
    if (!this.isInitialized) {
      return { text: 'Sorry, the AI assistant is still initializing. Please try again in a moment.', screenshots: [] };
    }

    // Emit initial thinking progress
    onProgress?.({ type: 'thinking', message: 'Thinking...', timestamp: new Date() });

    // Sanitize user input to protect against prompt injection
    const sanitizedMessage = sanitize(userMessage, 4000);

    // Start a new trace for this request with the user message as input
    const trace = this.traceService.startTrace(chatId, undefined, { userMessage: sanitizedMessage });

    this.agentLogger.info(LogEvent.MESSAGE_RECEIVED, `Received message`, {
      chatId,
      data: {
        traceId: trace.traceId.slice(0, 8),
        messagePreview: sanitizedMessage.slice(0, 100),
        attachedFiles: attachedFiles?.length || 0,
      },
    });

    // Load messages from persistent memory
    const memoryMessages = this.memoryService.getMessages(chatId);
    const messages: BaseMessage[] = this.convertMemoryToMessages(memoryMessages);

    // Add the new user message - with multi-modal content if files attached
    const userHumanMessage = this.buildUserMessage(sanitizedMessage, attachedFiles);
    messages.push(userHumanMessage);

    // Save sanitized user message to memory with file attachments if present
    const memoryText = attachedFiles?.length
      ? `[User sent ${attachedFiles.length} file(s)] ${sanitizedMessage}`
      : sanitizedMessage;

    // Convert AttachedFile to FileAttachment format for memory storage
    const memoryAttachments: FileAttachment[] | undefined = attachedFiles?.map((f) => ({
      fileId: f.id,
      fileName: f.path.split('/').pop() || 'unknown',
      filePath: f.path,
      mimeType: f.mimeType,
    }));

    await this.memoryService.addMessage(chatId, 'user', memoryText, memoryAttachments);

    try {
      // Build agent with user-specific tools and system prompt
      const agent = this.buildAgent(chatId, trace.traceId, trace.rootSpanId, onProgress);

      const result = await agent.invoke({
        messages: messages,
        traceId: trace.traceId,
        rootSpanId: trace.rootSpanId,
      });

      const finalContent = result.messages.at(-1)?.content;
      const text = typeof finalContent === 'string' ? finalContent : JSON.stringify(finalContent);

      // Collect screenshot paths and sent files from tool message artifacts
      const screenshots: string[] = [];
      const sentFiles: FileAttachment[] = [];
      for (const msg of result.messages ?? []) {
        if (ToolMessage.isInstance(msg) && msg.artifact) {
          // Collect screenshots from browser tasks
          if (msg.artifact.screenshots?.length) {
            screenshots.push(...msg.artifact.screenshots);
          }
          // Collect sent files from sendStoredFile tool
          if (msg.artifact.sentFile) {
            const sf = msg.artifact.sentFile;
            sentFiles.push({
              fileId: sf.fileId,
              fileName: sf.fileName,
              filePath: sf.filePath,
              mimeType: sf.mimeType,
            });
          }
        }
      }

      // Record token usage
      const inputTokens = result.inputTokens || 0;
      const outputTokens = result.outputTokens || 0;

      if (inputTokens > 0 || outputTokens > 0) {
        this.usageService.recordUsage(chatId, inputTokens, outputTokens);
        this.agentLogger.debug(LogEvent.LLM_RESPONSE, `Token usage: ${inputTokens} in, ${outputTokens} out`, { chatId });
      }

      // Save assistant response to memory (include sent files as attachments)
      await this.memoryService.addMessage(
        chatId,
        'assistant',
        text,
        sentFiles.length > 0 ? sentFiles : undefined,
      );

      // End the trace and log summary
      this.traceService.endSpan(trace.rootSpanId, {
        inputTokens,
        outputTokens,
        llmCalls: result.llmCalls,
      });

      const traceSummary = this.traceService.getTraceSummary(trace.traceId);
      this.agentLogger.info(LogEvent.RESPONSE_SENT, `Sent response (${text.length} chars)`, {
        chatId,
        data: {
          traceId: trace.traceId.slice(0, 8),
          totalDurationMs: traceSummary?.totalDurationMs,
          spanCount: traceSummary?.spanCount,
        },
      });

      // Update trace output and end trace (flush to Langfuse)
      this.traceService.updateTraceOutput(trace.traceId, {
        response: text,
        screenshots: screenshots.length,
        llmCalls: result.llmCalls,
        inputTokens,
        outputTokens,
      });
      this.traceService.endTrace(trace.traceId);

      return { text, screenshots };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.traceService.endSpanWithError(trace.rootSpanId, errorMessage);
      this.agentLogger.error(LogEvent.ERROR, errorMessage, {
        chatId,
        data: { traceId: trace.traceId.slice(0, 8) },
      });
      // End trace even on error to flush what we have
      this.traceService.endTrace(trace.traceId);
      return { text: `Sorry, I encountered an error: ${errorMessage}`, screenshots: [] };
    }
  }

  /**
   * Convert memory messages to LangChain BaseMessage format
   */
  private convertMemoryToMessages(memoryMessages: Array<{ role: string; content: string }>): BaseMessage[] {
    return memoryMessages.map((msg) => {
      if (msg.role === 'user') {
        return new HumanMessage(msg.content);
      } else if (msg.role === 'assistant') {
        return new AIMessage(msg.content);
      } else if (msg.role === 'summary') {
        // Include summary as a system message for context
        return new SystemMessage(`[Previous conversation summary]: ${msg.content}`);
      }
      return new HumanMessage(msg.content);
    });
  }

  /**
   * Build a HumanMessage with optional multi-modal content (text + images)
   */
  private buildUserMessage(text: string, attachedFiles?: AttachedFile[]): HumanMessage {
    // If no files or no image files, return simple text message
    const imageFiles = attachedFiles?.filter((f) => f.mimeType.startsWith('image/')) || [];

    if (imageFiles.length === 0) {
      return new HumanMessage(text);
    }

    // Build multi-modal content array
    const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
      { type: 'text', text },
    ];

    // Add images as base64 data URLs
    for (const file of imageFiles) {
      try {
        if (fs.existsSync(file.path)) {
          const imageBuffer = fs.readFileSync(file.path);
          const base64Image = imageBuffer.toString('base64');
          content.push({
            type: 'image_url',
            image_url: {
              url: `data:${file.mimeType};base64,${base64Image}`,
            },
          });
          this.logger.debug(`Added image to message: ${file.path}`);
        }
      } catch (error) {
        this.logger.warn(`Failed to read image file ${file.path}: ${error}`);
      }
    }

    return new HumanMessage({ content });
  }

  async clearConversation(chatId: string): Promise<void> {
    await this.memoryService.resetMemory(chatId);
    this.agentLogger.info(LogEvent.CONVERSATION_CLEARED, 'Conversation cleared', { chatId });
  }

  private async cleanup(): Promise<void> {
    this.agentLogger.info(LogEvent.MCP_CLEANUP, 'Shutting down agent service');

    if (this.mcpClient) {
      try {
        await this.mcpClient.close();
      } catch (error) {
        this.logger.warn(`Failed to close MCP client: ${error}`);
      }
    }
  }

  /**
   * Get list of available tools (base tools without chat context)
   */
  getAvailableTools(): string[] {
    const baseTools = Object.keys(this.toolsService.getLocalTools());
    const profileTools = ['getProfile', 'updateProfile'];
    const schedulerTools = ['createSchedule', 'listSchedules', 'cancelSchedule'];
    const browserTools = ['executeBrowserTask'];
    const coderTools = ['executeCoderTask', 'listCoderProjects', 'switchCoderProject'];
    const zapierToolNames = Object.keys(this.zapierTools);

    return [...baseTools, ...profileTools, ...schedulerTools, ...browserTools, ...coderTools, ...zapierToolNames];
  }
}
