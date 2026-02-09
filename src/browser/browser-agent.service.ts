/**
 * BROWSER SUB-AGENT – Runs only when the main agent calls executeBrowserTask.
 * Takes a task string (e.g. "go to example.com and get the USD rate"), plans steps
 * via TaskPlannerService, runs them using BrowserToolsService (navigate, screenshot,
 * extract_vision, answer_vision, etc.), then returns a summary plus extracted data
 * and screenshot paths. Used by both direct user messages and by the Scheduler
 * when a scheduled job triggers a browser task.
 */
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, HumanMessage, SystemMessage, BaseMessage } from '@langchain/core/messages';
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
import { BrowserToolsService } from './browser-tools.service';
import { TaskPlannerService, TaskPlan } from './task-planner.service';
import { AgentLoggerService, LogEvent } from '../logger/agent-logger.service';
import { ModelFactoryService } from '../model/model-factory.service';
import { safeJsonParse } from '../utils/input-sanitizer';

export interface BrowserTaskResult {
  success: boolean;
  taskDescription: string;
  summary: string;
  data?: any;
  screenshots?: string[];
  error?: string;
  stepsCompleted: number;
  totalSteps: number;
}

// Safety limits to prevent infinite loops
const MAX_STEP_EXECUTIONS = 50; // Maximum total step executions (including retries)
const MAX_PLAN_STEPS = 20; // Maximum steps allowed in a plan

interface BrowserAgentState {
  messages: BaseMessage[];
  task: string;
  chatId: string | null;
  plan: TaskPlan | null;
  currentStepIndex: number;
  completedSteps: string[];
  extractedData: any[];
  screenshots: string[];
  error: string | null;
  status: 'planning' | 'executing' | 'verifying' | 'replanning' | 'completed' | 'failed';
  retryCount: number;
  maxRetries: number;
  totalExecutions: number; // Track total step executions to prevent infinite loops
}

@Injectable()
export class BrowserAgentService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BrowserAgentService.name);
  private model: ChatOpenAI;
  private isInitialized = false;

  constructor(
    private readonly browserTools: BrowserToolsService,
    private readonly taskPlanner: TaskPlannerService,
    private readonly agentLogger: AgentLoggerService,
    private readonly modelFactory: ModelFactoryService,
  ) { }

  async onModuleInit() {
    this.initialize();
  }

  async onModuleDestroy() {
    await this.browserTools.closeBrowser();
  }

  private initialize(): void {
    if (!process.env.OPENROUTER_API_KEY) {
      this.logger.warn('OPENROUTER_API_KEY not set, browser agent will not work');
      return;
    }

    // Use ModelFactory for centralized model management
    this.model = this.modelFactory.getModel('main');

    this.isInitialized = true;
    this.logger.log('Browser agent service initialized');
  }

  /**
   * Execute a browser automation task
   */
  async executeTask(task: string, chatId?: string): Promise<BrowserTaskResult> {

    if (!this.isInitialized) {
      return {
        success: false,
        taskDescription: task,
        summary: 'Browser agent not initialized',
        error: 'OPENROUTER_API_KEY not configured',
        stepsCompleted: 0,
        totalSteps: 0,
      };
    }

    this.agentLogger.info(LogEvent.AGENT_INIT, `Starting browser task: ${task}`, { chatId });

    try {
      // Build and run the agent graph
      const agent = this.buildAgentGraph();

      const initialState: Partial<BrowserAgentState> = {
        messages: [new HumanMessage(task)],
        task,
        chatId: chatId || null,
        plan: null,
        currentStepIndex: 0,
        completedSteps: [],
        extractedData: [],
        screenshots: [],
        error: null,
        status: 'planning',
        retryCount: 0,
        maxRetries: 3,
        totalExecutions: 0,
      };

      const result = await agent.invoke(initialState);

      // Close browser after task
      await this.browserTools.closeBrowser();

      // Cast result to expected type for type safety
      const finalState = result as unknown as BrowserAgentState;

      const success = finalState.status === 'completed';
      const stepsCompleted = finalState.completedSteps?.length || 0;
      const totalSteps = finalState.plan?.steps?.length || 0;

      this.agentLogger.info(
        success ? LogEvent.RESPONSE_SENT : LogEvent.ERROR,
        `Browser task ${success ? 'completed' : 'failed'}: ${stepsCompleted}/${totalSteps} steps`,
        { chatId },
      );

      return {
        success,
        taskDescription: task,
        summary: this.generateSummary(finalState),
        data: finalState.extractedData?.length > 0 ? finalState.extractedData : undefined,
        screenshots: finalState.screenshots?.length > 0 ? finalState.screenshots : undefined,
        error: finalState.error || undefined,
        stepsCompleted,
        totalSteps,
      };

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.agentLogger.error(LogEvent.ERROR, `Browser task failed: ${errorMsg}`, { chatId });

      // Ensure browser is closed on error
      await this.browserTools.closeBrowser();

      return {
        success: false,
        taskDescription: task,
        summary: `Task failed: ${errorMsg}`,
        error: errorMsg,
        stepsCompleted: 0,
        totalSteps: 0,
      };
    }
  }

  /**
   * Build the LangGraph agent for browser automation
   */
  private buildAgentGraph() {
    const browserTools = this.browserTools;
    const taskPlanner = this.taskPlanner;
    const model = this.model;
    const logger = this.logger;
    const tools = browserTools.getTools();

    // Define state schema
    const BrowserState = new StateSchema({
      messages: MessagesValue,
      task: new ReducedValue(z.string(), { reducer: (_, y) => y }),
      chatId: new ReducedValue(z.string().nullable(), { reducer: (_, y) => y }),
      plan: new ReducedValue(z.any().nullable(), { reducer: (_, y) => y }),
      currentStepIndex: new ReducedValue(z.number(), { reducer: (_, y) => y }),
      completedSteps: new ReducedValue(z.array(z.string()), { reducer: (_, y) => y }),
      extractedData: new ReducedValue(z.array(z.any()), { reducer: (_, y) => y }),
      screenshots: new ReducedValue(z.array(z.string()), { reducer: (_, y) => y }),
      error: new ReducedValue(z.string().nullable(), { reducer: (_, y) => y }),
      status: new ReducedValue(z.string(), { reducer: (_, y) => y }),
      retryCount: new ReducedValue(z.number(), { reducer: (_, y) => y }),
      maxRetries: new ReducedValue(z.number(), { reducer: (_, y) => y }),
      totalExecutions: new ReducedValue(z.number(), { reducer: (_, y) => y }),
    });

    // Planning node
    const planNode: GraphNode<typeof BrowserState> = async (state) => {
      logger.log('Planning task...');

      try {
        const plan = await taskPlanner.planTask(state.task, undefined, state.chatId || undefined);

        // Enforce maximum plan steps to prevent overly complex plans
        if (plan.steps.length > MAX_PLAN_STEPS) {
          logger.warn(`Plan has ${plan.steps.length} steps, truncating to ${MAX_PLAN_STEPS}`);
          plan.steps = plan.steps.slice(0, MAX_PLAN_STEPS);
          plan.steps.push({
            stepNumber: MAX_PLAN_STEPS + 1,
            action: 'complete',
            description: 'Task truncated due to complexity limit',
          });
        }

        logger.log(`Created plan with ${plan.steps.length} steps`);

        return {
          plan,
          status: 'executing',
          messages: [new AIMessage(`Plan created: ${taskPlanner.formatPlanForDisplay(plan)}`)],
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
          error: `Planning failed: ${errorMsg}`,
          status: 'failed',
          messages: [new AIMessage(`Planning failed: ${errorMsg}`)],
        };
      }
    };

    // Execution node
    const executeNode: GraphNode<typeof BrowserState> = async (state) => {
      const { plan, currentStepIndex, completedSteps, extractedData, screenshots } = state;

      if (!plan || currentStepIndex >= plan.steps.length) {
        return { status: 'completed' };
      }

      const step = plan.steps[currentStepIndex];
      logger.log(`Executing step ${step.stepNumber}: ${step.description}`);

      try {
        let actionDecision: { action: string; params: Record<string, any>; reasoning: string };

        // Handle simple actions directly without AI reasoning
        const MAX_WAIT_MS = 5000; // Maximum wait time: 5 seconds

        if (step.action === 'wait' && step.value) {
          // Direct wait with specified milliseconds (capped at 5 seconds)
          const requestedMs = parseInt(step.value, 10) || 1000;
          const ms = Math.min(requestedMs, MAX_WAIT_MS);
          actionDecision = {
            action: 'browserWait',
            params: { milliseconds: ms },
            reasoning: `Wait ${ms}ms${requestedMs > MAX_WAIT_MS ? ` (capped from ${requestedMs}ms)` : ''} as specified in task`,
          };
        } else if (step.action === 'screenshot') {
          // Direct screenshot - only pass filename if explicitly provided
          actionDecision = {
            action: 'browserScreenshot',
            params: { fullPage: false },
            reasoning: 'Taking screenshot as requested',
          };
        } else if (step.action === 'navigate' && step.target) {
          // Direct navigation
          actionDecision = {
            action: 'browserNavigate',
            params: { url: step.target },
            reasoning: `Navigate to ${step.target}`,
          };
        } else if (step.action === 'extract_vision' || step.action === 'extract') {
          // Vision-based extraction (preferred method)
          actionDecision = {
            action: 'browserExtractVision',
            params: {
              description: step.target || step.description || 'Extract all visible data from the page',
              fullPage: false,
            },
            reasoning: 'Extract data using vision analysis (screenshot + AI)',
          };
        } else if (step.action === 'answer_vision') {
          // Answer a question about what is visible (do you see X? / is there Y?)
          actionDecision = {
            action: 'browserAnswerVision',
            params: {
              question: step.target || step.description || 'What do you see on this page?',
              fullPage: false,
            },
            reasoning: 'Answer question about page content using vision (screenshot + AI)',
          };
        } else if (step.action === 'extract_html') {
          // HTML-based extraction (fallback method)
          actionDecision = {
            action: 'browserExtractText',
            params: { selector: step.target },
            reasoning: 'Extract text from HTML (fallback method)',
          };
        } else if (step.action === 'scroll') {
          // Direct scroll
          const direction = step.target?.toLowerCase() === 'up' ? 'up' : 'down';
          actionDecision = {
            action: 'browserScroll',
            params: { direction, amount: 500 },
            reasoning: `Scroll ${direction}`,
          };
        } else if (step.action === 'complete') {
          // Complete action - just mark as done
          return {
            currentStepIndex: currentStepIndex + 1,
            completedSteps: [...completedSteps, `${step.description}: completed`],
            status: 'verifying',
            retryCount: 0,
            messages: [new AIMessage(`Task completed: ${step.description}`)],
          };
        } else {
          // For complex actions (click, type), use AI to determine exact parameters
          // Get current page snapshot for context
          let pageSnapshot = '';
          try {
            const snapshotResult = await tools.browserSnapshot.invoke({});
            const snapshotData = safeJsonParse(snapshotResult, { success: false, snapshot: '' });
            if (snapshotData.success) {
              pageSnapshot = snapshotData.snapshot;
            }
          } catch (e) {
            // No page loaded yet, that's ok for navigation steps
          }

          // Determine exact action based on step and page state
          actionDecision = await taskPlanner.determineNextAction(
            step,
            pageSnapshot,
            completedSteps,
            state.chatId || undefined,
          );
        }

        logger.log(`Action: ${actionDecision.action} - ${actionDecision.reasoning}`);

        // Execute the action
        const toolFn = tools[actionDecision.action];
        if (!toolFn) {
          throw new Error(`Unknown action: ${actionDecision.action}`);
        }

        // Coerce string booleans to actual booleans (LLM sometimes outputs "true" instead of true)
        const coercedParams = { ...actionDecision.params };
        for (const key of ['pressEnter', 'clearFirst', 'fullPage']) {
          if (key in coercedParams && typeof coercedParams[key] === 'string') {
            coercedParams[key] = coercedParams[key].toLowerCase() === 'true';
          }
        }

        const result = await toolFn.invoke(coercedParams);
        const resultData = safeJsonParse<Record<string, any>>(result, { success: false, error: 'Invalid JSON response' });

        // Update state based on result
        const newCompletedSteps = [...completedSteps, `${step.description}: ${resultData.message || 'completed'}`];
        let newExtractedData = [...extractedData];
        let newScreenshots = [...screenshots];

        // Collect extracted data (from vision, vision QA, and HTML extraction)
        if (actionDecision.action === 'browserExtractVision' && resultData.extractedData) {
          newExtractedData.push({
            step: step.stepNumber,
            description: step.description,
            text: resultData.extractedData,
            method: 'vision',
          });
        } else if (actionDecision.action === 'browserAnswerVision' && resultData.answer) {
          newExtractedData.push({
            step: step.stepNumber,
            description: step.description,
            text: resultData.answer,
            method: 'vision_answer',
          });
        } else if (actionDecision.action === 'browserExtractText' && resultData.text) {
          newExtractedData.push({
            step: step.stepNumber,
            description: step.description,
            text: resultData.text,
            method: 'html',
          });
        }

        // Collect screenshots
        if (actionDecision.action === 'browserScreenshot' && resultData.filepath) {
          newScreenshots.push(resultData.filepath);
        }
        if (actionDecision.action === 'browserAnswerVision' && resultData.screenshotPath) {
          newScreenshots.push(resultData.screenshotPath);
        }

        if (resultData.success === false) {
          throw new Error(resultData.error || 'Action failed');
        }

        return {
          currentStepIndex: currentStepIndex + 1,
          completedSteps: newCompletedSteps,
          extractedData: newExtractedData,
          screenshots: newScreenshots,
          status: 'verifying',
          retryCount: 0,
          totalExecutions: (state.totalExecutions || 0) + 1,
          messages: [new AIMessage(`Step ${step.stepNumber} completed: ${resultData.message}`)],
        };

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error(`Step failed: ${errorMsg}`);

        return {
          error: errorMsg,
          status: 'verifying',
          totalExecutions: (state.totalExecutions || 0) + 1,
          messages: [new AIMessage(`Step ${step.stepNumber} failed: ${errorMsg}`)],
        };
      }
    };

    // Verification node with retry logic and safety limits
    const verifyNode: GraphNode<typeof BrowserState> = async (state) => {
      const { plan, currentStepIndex, error, retryCount, maxRetries, totalExecutions } = state;

      // Safety check: prevent infinite loops by limiting total executions
      if ((totalExecutions || 0) >= MAX_STEP_EXECUTIONS) {
        logger.error(`Task exceeded maximum executions (${MAX_STEP_EXECUTIONS}), terminating`);
        return {
          status: 'failed',
          error: `Task exceeded maximum execution limit (${MAX_STEP_EXECUTIONS} steps)`,
        };
      }

      // If there was an error, check if we should retry
      if (error) {
        if (retryCount < maxRetries) {
          logger.warn(`Step failed, retrying (${retryCount + 1}/${maxRetries}): ${error}`);
          return {
            status: 'executing',
            retryCount: retryCount + 1,
            error: null, // Clear error for retry
          };
        }
        // Max retries exceeded, fail
        logger.error(`Task failed after ${retryCount} retries: ${error}`);
        return { status: 'failed' };
      }

      // Check if all steps completed
      if (plan && currentStepIndex >= plan.steps.length) {
        return { status: 'completed' };
      }

      // Continue to next step
      return { status: 'executing' };
    };

    // Replanning node
    // Router function - simple: continue executing or end
    const routeFromVerify: ConditionalEdgeRouter<typeof BrowserState, Record<string, any>> = (state) => {
      if (state.status === 'executing') {
        return 'execute';
      }
      // completed or failed - end
      return END;
    };

    // Build the graph
    // Note: Node names must not conflict with state attribute names
    return new StateGraph(BrowserState)
      .addNode('planning', planNode)
      .addNode('execute', executeNode)
      .addNode('verify', verifyNode)
      .addEdge(START, 'planning')
      .addEdge('planning', 'execute')
      .addEdge('execute', 'verify')
      .addConditionalEdges('verify', routeFromVerify, ['execute', END])
      .compile();
  }

  /**
   * Generate a summary of the task execution
   */
  private generateSummary(state: BrowserAgentState): string {
    const parts: string[] = [];

    if (state.status === 'completed') {
      parts.push(`✅ Task completed successfully.`);
    } else if (state.status === 'failed') {
      parts.push(`❌ Task failed: ${state.error}`);
    }

    if (state.completedSteps.length > 0) {
      parts.push(`\nCompleted ${state.completedSteps.length} steps:`);
      for (const step of state.completedSteps.slice(-5)) {
        parts.push(`  • ${step}`);
      }
      if (state.completedSteps.length > 5) {
        parts.push(`  ... and ${state.completedSteps.length - 5} more`);
      }
    }

    if (state.extractedData.length > 0) {
      parts.push(`\nExtracted ${state.extractedData.length} data item(s).`);
    }

    if (state.screenshots.length > 0) {
      parts.push(`\nCaptured ${state.screenshots.length} screenshot(s).`);
    }

    return parts.join('\n');
  }

  /**
   * Execute a simple browser action (for direct tool calls)
   */
  async executeSimpleAction(
    action: string,
    params: Record<string, any>,
  ): Promise<{ success: boolean; result: any }> {
    const tools = this.browserTools.getTools();
    const toolFn = tools[action];

    if (!toolFn) {
      return {
        success: false,
        result: { error: `Unknown action: ${action}` },
      };
    }

    try {
      // Coerce string booleans to actual booleans
      const coercedParams = { ...params };
      for (const key of ['pressEnter', 'clearFirst', 'fullPage']) {
        if (key in coercedParams && typeof coercedParams[key] === 'string') {
          coercedParams[key] = coercedParams[key].toLowerCase() === 'true';
        }
      }

      const result = await toolFn.invoke(coercedParams);
      return {
        success: true,
        result: JSON.parse(result),
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        result: { error: errorMsg },
      };
    }
  }

  /**
   * Get current browser state (for debugging)
   */
  async getBrowserState(): Promise<{
    isOpen: boolean;
    url?: string;
    title?: string;
  }> {
    try {
      const tools = this.browserTools.getTools();
      const result = await tools.browserSnapshot.invoke({});
      const data = JSON.parse(result);

      return {
        isOpen: data.success,
        url: data.url,
        title: data.title,
      };
    } catch {
      return { isOpen: false };
    }
  }
}
