import { Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { UsageService } from '../usage/usage.service';
import { ConfigService } from 'src/config/config.service';

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

@Injectable()
export class TaskPlannerService {
  private readonly logger = new Logger(TaskPlannerService.name);
  private model: ChatOpenAI;

  constructor(private readonly usageService: UsageService, private readonly configService: ConfigService) {
    this.model = new ChatOpenAI({
      model: this.configService.getConfig().model,
      temperature: 0.3,
      configuration: {
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: process.env.OPENROUTER_API_KEY,
      },
    });
  }


  /**
   * Plan a browser automation task into steps
   */
  async planTask(taskDescription: string, currentPageContext?: string, chatId?: string): Promise<TaskPlan> {
    this.logger.log(`Planning task: ${taskDescription}`);

    const systemPrompt = `You are a browser automation task planner. Create MINIMAL steps for ONLY what the user explicitly asked.

Available actions:
- navigate: Go to a URL (target = URL)
- click: Click on an element (target = element description)
- type: Type text into an input field (target = field description, value = text to type)
- scroll: Scroll the page up or down (target = "up" or "down")
- screenshot: Take a screenshot (target = optional filename)
- extract_vision: Extract data using vision/screenshot analysis (PRIMARY method for data extraction - sends screenshot to LLM)
- extract_html: Extract text/data from HTML (FALLBACK only - use if vision extraction fails or data not visible in screenshot)
- answer_vision: Answer a question about what is visible on the page (screenshot + LLM). Use when user asks "do you see X?", "is there Y?", "check if ...", "tell me if ..." (target or description = the question to answer)
- wait: Wait for a duration (value = milliseconds, max 5000)
- complete: Mark task as complete

CRITICAL RULES:
1. ONLY include steps the user EXPLICITLY requested. Do NOT add extra steps.
2. Do NOT add verification, waiting, or extraction unless the user asked for it.
3. "Go to X" = navigate only, then complete. Nothing else.
4. "Go to X and take screenshot" = navigate + screenshot + complete. Nothing else.
5. "Wait X seconds" = convert to milliseconds (max 5000ms)
6. Always end with a complete step.

DATA EXTRACTION STRATEGY (IMPORTANT):
- When user asks to extract/get/fetch any data from a webpage, ALWAYS use extract_vision FIRST
- extract_vision takes a screenshot and uses AI vision to read and extract the requested data
- This works best for: prices, rates, tables, visible text, numbers, charts, any data shown on screen
- Only use extract_html as a FALLBACK if:
  * Vision extraction explicitly fails
  * Data is in hidden elements or requires scrolling through large lists
  * User specifically asks for raw HTML content

QUESTION-ANSWERING ABOUT THE PAGE (answer_vision):
- When user asks "check X and do you see ...?", "is there ... on the page?", "go to X and tell me if ...", use answer_vision
- answer_vision takes a screenshot and asks the LLM to answer the user's question (Yes/No or short description)
- target or description should be the question (e.g. "Is there a sale banner?", "Do you see a login form?")

Examples:
- "go to google.com" → navigate to google.com, complete
- "go to example.com and screenshot" → navigate, screenshot, complete
- "go to site.com, wait 3 seconds, screenshot" → navigate, wait 3000ms, screenshot, complete
- "go to bonbast.com and get the USD rate" → navigate, extract_vision (with description: "USD exchange rate"), complete
- "get prices from amazon.com/product" → navigate, extract_vision (with description: "product prices"), complete
- "check example.com and do you see a welcome banner?" → navigate, answer_vision (question: "Do you see a welcome banner?"), complete
- "go to x.com and is there anything about sales?" → navigate, answer_vision (question: "Is there anything about sales visible?"), complete

Output ONLY valid JSON:
{
  "taskDescription": "Brief description",
  "steps": [
    { "stepNumber": 1, "action": "navigate", "description": "Go to website", "target": "https://example.com" },
    { "stepNumber": 2, "action": "complete", "description": "Done" }
  ],
  "estimatedComplexity": "simple",
  "potentialChallenges": []
}`;

    const userPrompt = currentPageContext
      ? `Current page context:\n${currentPageContext}\n\nTask: ${taskDescription}`
      : `Task: ${taskDescription}`;

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

      // Extract JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No valid JSON found in response');
      }

      const plan = JSON.parse(jsonMatch[0]) as TaskPlan;

      // Validate and fix step numbers
      plan.steps = plan.steps.map((step, index) => ({
        ...step,
        stepNumber: index + 1,
      }));

      this.logger.log(`Created plan with ${plan.steps.length} steps`);
      return plan;

    } catch (error) {
      this.logger.error(`Failed to plan task: ${error}`);

      // Return a basic fallback plan
      return this.createFallbackPlan(taskDescription);
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

    const systemPrompt = `You are a browser automation task planner. A task partially completed and needs replanning.

Available actions: navigate, click, type, scroll, screenshot, extract_vision, extract_html, answer_vision, wait, verify, complete

DATA EXTRACTION: Always prefer extract_vision (screenshot + AI vision) over extract_html. Only use extract_html if vision fails.
QUESTION-ANSWERING: Use answer_vision when the task is to answer "do you see X?", "is there Y?", "check if ..." about the page.

Analyze what has been done and create remaining steps to complete the task.

Output ONLY valid JSON in this exact format:
{
  "taskDescription": "Remaining work to complete",
  "steps": [{ "stepNumber": 1, "action": "...", "description": "...", "target": "...", "expectedOutcome": "..." }],
  "estimatedComplexity": "simple|moderate|complex",
  "potentialChallenges": ["..."]
}`;

    const userPrompt = `Original task: ${originalTask}

Completed steps:
${completedSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}

Current page state:
${currentPageContext}

${failureReason ? `Last failure: ${failureReason}` : ''}

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

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No valid JSON found in response');
      }

      const plan = JSON.parse(jsonMatch[0]) as TaskPlan;
      plan.steps = plan.steps.map((step, index) => ({
        ...step,
        stepNumber: index + 1,
      }));

      return plan;

    } catch (error) {
      this.logger.error(`Failed to replan: ${error}`);
      return this.createFallbackPlan(`Complete: ${originalTask}`);
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
    const systemPrompt = `You are executing a browser automation step. Based on the current page snapshot and step requirements, determine the exact action to take.

Current step to execute:
- Action: ${currentStep.action}
- Description: ${currentStep.description}
- Target: ${currentStep.target || 'Not specified'}
- Value: ${currentStep.value || 'Not specified'}

Previous actions in this session:
${previousActions.slice(-5).join('\n') || 'None'}

Page snapshot (accessibility tree):
${pageSnapshot}

Determine the exact action parameters. Look for elements in the snapshot that match the step description.
For clicks, find the element ref that best matches the target.
For typing, find the input field ref that matches.

Output ONLY valid JSON:
{
  "action": "browserNavigate|browserClick|browserType|browserScroll|browserScreenshot|browserExtractVision|browserAnswerVision|browserExtractText|browserWait",
  "params": { ... action-specific parameters ... },
  "reasoning": "Brief explanation of why this action"
}

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

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No valid JSON found');
      }

      return JSON.parse(jsonMatch[0]);

    } catch (error) {
      this.logger.error(`Failed to determine action: ${error}`);
      throw error;
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
