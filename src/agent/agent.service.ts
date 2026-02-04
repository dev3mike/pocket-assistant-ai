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
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, BaseMessage } from '@langchain/core/messages';
import { ConfigService } from '../config/config.service';
import { AgentLoggerService, LogEvent } from '../logger/agent-logger.service';
import { ToolsService } from './tools.service';
import { SoulService } from '../soul/soul.service';
import { MemoryService } from '../memory/memory.service';
import { UsageService } from '../usage/usage.service';


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
    private readonly toolsService: ToolsService,
    private readonly soulService: SoulService,
    private readonly memoryService: MemoryService,
    private readonly usageService: UsageService,
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

    this.model = new ChatOpenAI({
      model: this.configService.getConfig().model,
      temperature: 0,
      configuration: {
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: process.env.OPENROUTER_API_KEY,
      },
    });

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
   * Build the system prompt with soul context for a specific user
   */
  private buildSystemPrompt(chatId: string): string {
    const soulContext = this.soulService.getSoulContext(chatId);

    const basePrompt = `You are a helpful AI assistant in a Telegram bot.

Available capabilities:
- Get current date/time
- Enable/disable logging (console and file)
- Update your name or personality (if user asks to change it)
- Update user profile information
- Add preferences or context to remember
- View current profile settings
- Schedule reminders and tasks (one-time or recurring)
- List and manage scheduled tasks
- Browser automation (visit websites, extract data, fill forms, take screenshots)
- Zapier integrations (if configured)

Be concise in your responses. Use tools when needed.
When the user wants to update their profile or your settings, use the appropriate tool.
When the user asks to be reminded about something or schedule a task, use the createSchedule tool.
IMPORTANT: Before scheduling, ensure you have COMPLETE details about what should happen. If the request is vague (e.g., "schedule a morning brief"), ask what it should include before creating the schedule. Do NOT make assumptions about what the user wants.
For natural language time like "in 2 hours" or "tomorrow at 9am", convert to ISO date format for one-time tasks.
For recurring patterns like "every Monday" or "daily at 9am", use cron expressions.
When the user asks to visit a website, search the web, extract information from a webpage, or perform any web-based task, use the executeBrowserTask tool.`;

    if (soulContext) {
      return `${soulContext}

---

${basePrompt}`;
    }

    return basePrompt;
  }

  /**
   * Build and run the agent for a specific conversation
   */
  private buildAgent(chatId: string) {
    // Get tools specific to this chat
    const toolsByName = this.getToolsForChat(chatId);
    const tools = Object.values(toolsByName);

    // Bind tools to model for this request
    const modelWithTools = this.model.bindTools(tools);

    const agentLogger = this.agentLogger;
    const usageService = this.usageService;
    const systemPrompt = this.buildSystemPrompt(chatId);

    const MessagesState = new StateSchema({
      messages: MessagesValue,
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
      agentLogger.info(LogEvent.LLM_INVOKE, `Invoking LLM (call #${state.llmCalls + 1})`, { chatId });

      const response = await modelWithTools.invoke([new SystemMessage(systemPrompt), ...state.messages]);

      // Extract token usage from response using helper
      let inTokens = 0;
      let outTokens = 0;
      if (AIMessage.isInstance(response)) {
        const usage = usageService.extractUsageFromResponse(response);
        inTokens = usage.inputTokens;
        outTokens = usage.outputTokens;
      }

      if (AIMessage.isInstance(response)) {
        if (response.tool_calls?.length) {
          agentLogger.info(
            LogEvent.TOOL_CALL_REQUESTED,
            `LLM requested ${response.tool_calls.length} tool call(s)`,
            {
              chatId,
              data: { toolCalls: response.tool_calls.map((tc) => ({ name: tc.name, args: tc.args })) },
            },
          );
        } else {
          agentLogger.info(LogEvent.LLM_RESPONSE, 'LLM generated response', {
            chatId,
            data: { contentPreview: String(response.content).slice(0, 100) },
          });
        }
      }

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
        agentLogger.info(LogEvent.TOOL_EXECUTING, `Executing tool: ${toolCall.name}`, {
          chatId,
          data: { args: toolCall.args },
        });

        const selectedTool = toolsByName[toolCall.name];

        if (!selectedTool) {
          agentLogger.error(LogEvent.TOOL_ERROR, `Tool not found: ${toolCall.name}`, { chatId });
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
            data: { result: String(observation).slice(0, 200) },
          });
          results.push(observation);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          agentLogger.error(LogEvent.TOOL_ERROR, `Tool ${toolCall.name} failed: ${errorMessage}`, {
            chatId,
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

  async processMessage(chatId: string, userMessage: string): Promise<{ text: string; screenshots: string[] }> {
    if (!this.isInitialized) {
      return { text: 'Sorry, the AI assistant is still initializing. Please try again in a moment.', screenshots: [] };
    }

    this.agentLogger.info(LogEvent.MESSAGE_RECEIVED, `Received message`, {
      chatId,
      data: { messagePreview: userMessage.slice(0, 100) },
    });

    // Load messages from persistent memory
    const memoryMessages = this.memoryService.getMessages(chatId);
    const messages: BaseMessage[] = this.convertMemoryToMessages(memoryMessages);

    // Add the new user message
    messages.push(new HumanMessage(userMessage));

    // Save user message to memory
    await this.memoryService.addMessage(chatId, 'user', userMessage);

    try {
      // Build agent with user-specific tools and system prompt
      const agent = this.buildAgent(chatId);

      const result = await agent.invoke({
        messages: messages,
      });

      const finalContent = result.messages.at(-1)?.content;
      const text = typeof finalContent === 'string' ? finalContent : JSON.stringify(finalContent);

      // Collect screenshot paths from tool message artifacts (executeBrowserTask returns content_and_artifact)
      const screenshots: string[] = [];
      for (const msg of result.messages ?? []) {
        if (ToolMessage.isInstance(msg) && msg.artifact?.screenshots?.length) {
          screenshots.push(...msg.artifact.screenshots);
        }
      }

      // Record token usage
      const inputTokens = result.inputTokens || 0;
      const outputTokens = result.outputTokens || 0;

      if (inputTokens > 0 || outputTokens > 0) {
        this.usageService.recordUsage(chatId, inputTokens, outputTokens);
        this.agentLogger.debug(LogEvent.LLM_RESPONSE, `Token usage: ${inputTokens} in, ${outputTokens} out`, { chatId });
      }

      // Save assistant response to memory (text only)
      await this.memoryService.addMessage(chatId, 'assistant', text);

      this.agentLogger.info(LogEvent.RESPONSE_SENT, `Sent response (${text.length} chars)`, { chatId });

      return { text, screenshots };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.agentLogger.error(LogEvent.ERROR, errorMessage, { chatId });
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

  clearConversation(chatId: string): void {
    this.memoryService.resetMemory(chatId);
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
    const zapierToolNames = Object.keys(this.zapierTools);

    return [...baseTools, ...profileTools, ...schedulerTools, ...browserTools, ...zapierToolNames];
  }
}
