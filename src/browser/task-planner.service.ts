/**
 * Plans browser tasks for the BROWSER SUB-AGENT. Turns a task string (e.g. "go to
 * bonbast.com and get the USD rate") into a list of steps: navigate, screenshot,
 * extract_vision, answer_vision, wait, complete, etc. Also used to replan after
 * failures and to determineNextAction (e.g. which element to click) when the
 * browser agent needs to resolve a step into concrete tool parameters.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { UsageService } from '../usage/usage.service';
import { ModelFactoryService } from '../model/model-factory.service';
import { PromptService } from '../prompts/prompt.service';
import { sanitize, safeJsonParse, extractAndParseJson } from '../utils/input-sanitizer';

export type TaskStepAction =
  | 'navigate'
  | 'click'
  | 'type'
  | 'scroll'
  | 'screenshot'
  | 'extract'
  | 'extract_vision'
  | 'extract_html'
  | 'answer_vision'
  | 'wait'
  | 'verify'
  | 'complete';

export interface TaskStep {
  stepNumber: number;
  action: TaskStepAction;
  description: string;
  target?: string;
  value?: string;
  expectedOutcome?: string;
}

export interface TaskPlan {
  taskDescription: string;
  steps: TaskStep[];
  estimatedComplexity: 'simple' | 'moderate' | 'complex';
  potentialChallenges: string[];
}

// Zod schema for structured task plan output
const TaskStepSchema = z.object({
  stepNumber: z.number(),
  action: z.enum([
    'navigate',
    'click',
    'type',
    'scroll',
    'screenshot',
    'extract',
    'extract_vision',
    'extract_html',
    'answer_vision',
    'wait',
    'verify',
    'complete',
  ]),
  description: z.string(),
  target: z.string().optional(),
  value: z.string().optional(),
  expectedOutcome: z.string().optional(),
});

const TaskPlanSchema = z.object({
  taskDescription: z.string(),
  steps: z.array(TaskStepSchema),
  estimatedComplexity: z.enum(['simple', 'moderate', 'complex']),
  potentialChallenges: z.array(z.string()),
});

// Zod schema for action decision
const ActionDecisionSchema = z.object({
  action: z.string(),
  params: z.record(z.string(), z.any()),
  reasoning: z.string(),
});

@Injectable()
export class TaskPlannerService {
  private readonly logger = new Logger(TaskPlannerService.name);
  private model: ChatOpenAI;

  constructor(
    private readonly usageService: UsageService,
    private readonly modelFactory: ModelFactoryService,
    private readonly promptService: PromptService,
  ) {
    // Use ModelFactory with slightly creative temperature for task planning
    this.model = this.modelFactory.getModel('main', { temperature: 0.3 });
  }


  /**
   * Plan a browser automation task into steps
   */
  async planTask(taskDescription: string, currentPageContext?: string, chatId?: string): Promise<TaskPlan> {
    // Sanitize input to protect against prompt injection
    const sanitizedTask = sanitize(taskDescription, 2000);
    this.logger.log(`Planning task: ${sanitizedTask}`);

    // Get system prompt from PromptService (supports hot-reload)
    const systemPrompt = this.promptService.buildTaskPlannerPrompt();

    const userPrompt = currentPageContext
      ? `Current page context:\n${sanitize(currentPageContext, 2000)}\n\nTask: ${sanitizedTask}`
      : `Task: ${sanitizedTask}`;

    try {
      // Try structured output first for guaranteed valid JSON
      const structuredModel = this.modelFactory.getStructuredModel('main', TaskPlanSchema, { temperature: 0.3 });

      const plan = await structuredModel.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(userPrompt),
      ]) as TaskPlan;

      // Record usage if we can get the response metadata
      if (chatId) {
        // Note: structured output doesn't return AIMessage, so usage tracking is limited here
        this.logger.debug('Task planned with structured output');
      }

      // Validate and fix step numbers
      plan.steps = plan.steps.map((step, index) => ({
        ...step,
        stepNumber: index + 1,
      }));

      this.logger.log(`Created plan with ${plan.steps.length} steps`);
      return plan;

    } catch (structuredError) {
      // Fallback to regular model with JSON extraction if structured output fails
      this.logger.warn(`Structured output failed, falling back to JSON extraction: ${structuredError}`);

      try {
        const response = await this.model.invoke([
          new SystemMessage(systemPrompt),
          new HumanMessage(userPrompt),
        ]);

        if (AIMessage.isInstance(response)) {
          this.usageService.recordUsageFromResponse(chatId, response);
        }

        const content = typeof response.content === 'string'
          ? response.content
          : String(response.content);

        // Use safe JSON extraction
        const plan = extractAndParseJson<TaskPlan>(content, this.createFallbackPlan(sanitizedTask));

        // Validate and fix step numbers
        plan.steps = plan.steps.map((step, index) => ({
          ...step,
          stepNumber: index + 1,
        }));

        this.logger.log(`Created plan with ${plan.steps.length} steps (fallback mode)`);
        return plan;

      } catch (error) {
        this.logger.error(`Failed to plan task: ${error}`);
        return this.createFallbackPlan(sanitizedTask);
      }
    }
  }

  /**
   * Replan based on current state and what has been accomplished
   */
  async replanFromState(
    originalTask: string,
    completedSteps: string[],
    currentPageContext: string,
    failureReason?: string,
    chatId?: string,
  ): Promise<TaskPlan> {
    this.logger.log(`Replanning task after ${completedSteps.length} completed steps`);

    // Sanitize inputs
    const sanitizedTask = sanitize(originalTask, 1500);
    const sanitizedContext = sanitize(currentPageContext, 1500);

    // Get replan prompt from PromptService
    const systemPrompt = this.promptService.getPrompt('browser-planner', 'replan') ||
      `You are a browser automation task planner. A task partially completed and needs replanning.

Available actions: navigate, click, type, scroll, screenshot, extract_vision, extract_html, answer_vision, wait, verify, complete

DATA EXTRACTION: Always prefer extract_vision (screenshot + AI vision) over extract_html. Only use extract_html if vision fails.
QUESTION-ANSWERING: Use answer_vision when the task is to answer "do you see X?", "is there Y?", "check if ..." about the page.

Analyze what has been done and create remaining steps to complete the task.`;

    const userPrompt = `Original task: ${sanitizedTask}

Completed steps:
${completedSteps.slice(-10).map((s, i) => `${i + 1}. ${sanitize(s, 200)}`).join('\n')}

Current page state:
${sanitizedContext}

${failureReason ? `Last failure: ${sanitize(failureReason, 500)}` : ''}

Create a plan for the remaining steps needed to complete the original task.`;

    try {
      const response = await this.model.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(userPrompt),
      ]);

      if (AIMessage.isInstance(response)) {
        this.usageService.recordUsageFromResponse(chatId, response);
      }

      const content = typeof response.content === 'string'
        ? response.content
        : String(response.content);

      // Use safe JSON extraction
      const plan = extractAndParseJson<TaskPlan>(content, this.createFallbackPlan(`Complete: ${sanitizedTask}`));
      plan.steps = plan.steps.map((step, index) => ({
        ...step,
        stepNumber: index + 1,
      }));

      return plan;

    } catch (error) {
      this.logger.error(`Failed to replan: ${error}`);
      return this.createFallbackPlan(`Complete: ${sanitizedTask}`);
    }
  }

  /**
   * Determine the next action based on current page state and task
   */
  async determineNextAction(
    currentStep: TaskStep,
    pageSnapshot: string,
    previousActions: string[],
    chatId?: string,
  ): Promise<{
    action: string;
    params: Record<string, any>;
    reasoning: string;
  }> {
    // Sanitize page snapshot (can be large)
    const sanitizedSnapshot = sanitize(pageSnapshot, 8000);

    // Get base prompt from PromptService
    const basePrompt = this.promptService.getPrompt('browser-planner', 'determineAction') ||
      `Determine the exact action parameters. Look for elements in the snapshot that match the step description.
For clicks, find the element ref that best matches the target.
For typing, find the input field ref that matches.

For browserClick: params = { "ref": "e5" }
For browserType: params = { "ref": "e3", "text": "search query", "pressEnter": true }
For browserNavigate: params = { "url": "https://..." }
For browserScroll: params = { "direction": "down", "amount": 500 }
For browserScreenshot: params = { "fullPage": false }
For browserExtractVision: params = { "description": "what data to extract from the screenshot" } - PREFERRED for data extraction
For browserAnswerVision: params = { "question": "user's question about what is visible (e.g. Do you see X? Is there Y?)" } - for check/see/is there questions
For browserExtractText: params = { "selector": "optional" } - FALLBACK only if vision fails
For browserWait: params = { "milliseconds": 1000 } or { "forText": "..." }

IMPORTANT: For data extraction, ALWAYS prefer browserExtractVision over browserExtractText. For "do you see X?" / "is there Y?" use browserAnswerVision.`;

    const systemPrompt = `You are executing a browser automation step. Based on the current page snapshot and step requirements, determine the exact action to take.

Current step to execute:
- Action: ${sanitize(currentStep.action, 100)}
- Description: ${sanitize(currentStep.description, 500)}
- Target: ${sanitize(currentStep.target || 'Not specified', 500)}
- Value: ${sanitize(currentStep.value || 'Not specified', 500)}

Previous actions in this session:
${previousActions.slice(-5).map(a => sanitize(a, 200)).join('\n') || 'None'}

Page snapshot (accessibility tree):
${sanitizedSnapshot}

${basePrompt}`;

    try {
      // Try structured output first
      const structuredModel = this.modelFactory.getStructuredModel('main', ActionDecisionSchema, { temperature: 0.3 });

      const result = await structuredModel.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage('Determine the next action based on the context above.'),
      ]);

      return result as { action: string; params: Record<string, any>; reasoning: string };

    } catch (structuredError) {
      // Fallback to regular model with JSON extraction
      this.logger.warn(`Structured output failed for action decision, falling back: ${structuredError}`);

      try {
        const response = await this.model.invoke([
          new SystemMessage(systemPrompt),
          new HumanMessage('Determine the next action based on the context above.'),
        ]);

        if (AIMessage.isInstance(response)) {
          this.usageService.recordUsageFromResponse(chatId, response);
        }

        const content = typeof response.content === 'string'
          ? response.content
          : String(response.content);

        // Use safe JSON extraction
        const defaultAction = {
          action: 'browserScreenshot',
          params: { fullPage: false },
          reasoning: 'Fallback action due to parsing failure',
        };
        return extractAndParseJson(content, defaultAction);

      } catch (error) {
        this.logger.error(`Failed to determine action: ${error}`);
        throw error;
      }
    }
  }

  /**
   * Create a basic fallback plan
   */
  private createFallbackPlan(taskDescription: string): TaskPlan {
    // Try to extract URL from task
    const urlMatch = taskDescription.match(/https?:\/\/[^\s]+/);
    const steps: TaskStep[] = [];

    if (urlMatch) {
      steps.push({
        stepNumber: 1,
        action: 'navigate',
        description: 'Navigate to the specified URL',
        target: urlMatch[0],
        expectedOutcome: 'Page loads successfully',
      });
    }

    steps.push({
      stepNumber: steps.length + 1,
      action: 'extract_vision',
      description: 'Extract page content using vision analysis',
      expectedOutcome: 'Content extracted from screenshot',
    });

    steps.push({
      stepNumber: steps.length + 1,
      action: 'complete',
      description: 'Task completed with available information',
      expectedOutcome: 'Results returned to user',
    });

    return {
      taskDescription,
      steps,
      estimatedComplexity: 'simple',
      potentialChallenges: ['Task may need manual refinement'],
    };
  }

  /**
   * Validate if a step was successful based on outcome
   */
  async validateStepOutcome(
    step: TaskStep,
    actionResult: string,
    newPageSnapshot: string,
  ): Promise<{
    success: boolean;
    message: string;
    shouldRetry: boolean;
  }> {
    // Quick validation for common cases
    const result = JSON.parse(actionResult);

    if (result.success === false) {
      return {
        success: false,
        message: result.error || 'Action failed',
        shouldRetry: true,
      };
    }

    // For navigation, verify URL changed
    if (step.action === 'navigate') {
      return {
        success: true,
        message: `Navigated to ${result.url}`,
        shouldRetry: false,
      };
    }

    // For clicks, consider success if no error
    if (step.action === 'click') {
      return {
        success: true,
        message: `Clicked element successfully`,
        shouldRetry: false,
      };
    }

    // Default: trust the action result
    return {
      success: result.success !== false,
      message: result.message || 'Step completed',
      shouldRetry: false,
    };
  }

  /**
   * Format task plan for display
   */
  formatPlanForDisplay(plan: TaskPlan): string {
    const lines: string[] = [];

    lines.push(`📋 Task: ${plan.taskDescription}`);
    lines.push(`Complexity: ${plan.estimatedComplexity}`);
    lines.push('');
    lines.push('Steps:');

    for (const step of plan.steps) {
      let stepLine = `  ${step.stepNumber}. [${step.action}] ${step.description}`;
      if (step.target) {
        stepLine += ` → ${step.target}`;
      }
      lines.push(stepLine);
    }

    if (plan.potentialChallenges.length > 0) {
      lines.push('');
      lines.push('⚠️ Potential challenges:');
      for (const challenge of plan.potentialChallenges) {
        lines.push(`  - ${challenge}`);
      }
    }

    return lines.join('\n');
  }
}
