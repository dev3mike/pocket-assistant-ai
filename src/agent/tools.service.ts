import { Injectable, Logger } from '@nestjs/common';
import { tool } from '@langchain/core/tools';
import { ConfigService } from '../config/config.service';
import { AgentLoggerService, LogEvent } from '../logger/agent-logger.service';
import { SoulService } from '../soul/soul.service';
import { AiService } from '../ai/ai.service';
import { SchedulerService } from '../scheduler/scheduler.service';
import { BrowserAgentService } from '../browser/browser-agent.service';
import * as z from 'zod';

@Injectable()
export class ToolsService {
  private readonly logger = new Logger(ToolsService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly agentLogger: AgentLoggerService,
    private readonly soulService: SoulService,
    private readonly aiService: AiService,
    private readonly schedulerService: SchedulerService,
    private readonly browserAgentService: BrowserAgentService,
  ) { }

  /**
   * Get all available local tools (without chat context)
   */
  getLocalTools(): Record<string, any> {
    return {
      getCurrentDate: this.createGetCurrentDateTool(),
      setLogging: this.createSetLoggingTool(),
    };
  }

  /**
   * Get tools that require chat context (for updating user profile)
   */
  getToolsForChat(chatId: string): Record<string, any> {
    return {
      ...this.getLocalTools(),
      getProfile: this.createGetProfileTool(chatId),
      updateProfile: this.createUpdateProfileTool(chatId),
      createSchedule: this.createScheduleTool(chatId),
      listSchedules: this.createListSchedulesTool(chatId),
      cancelSchedule: this.createCancelScheduleTool(chatId),
      executeBrowserTask: this.createExecuteBrowserTaskTool(chatId),
    };
  }

  // ===== Basic Tools =====

  private createGetCurrentDateTool() {
    return tool(
      () => {
        const date = new Date().toISOString();
        this.agentLogger.info(LogEvent.TOOL_RESULT, `getCurrentDate: ${date}`);
        return date;
      },
      {
        name: 'getCurrentDate',
        description: 'Get the current date and time in ISO format',
      },
    );
  }

  private createSetLoggingTool() {
    return tool(
      async (input: { enabled: boolean }) => {
        await this.configService.setLoggingEnabled(input.enabled);

        if (input.enabled) {
          return 'Logging enabled. Logs will appear in console and be saved to logs/{date}.json.';
        }

        return 'Logging has been disabled.';
      },
      {
        name: 'setLogging',
        description:
          'Enable or disable logging. When enabled, logs appear in console and are saved to daily JSON files. Use this when the user wants to see what the agent is doing.',
        schema: z.object({
          enabled: z.boolean().describe('Whether to enable (true) or disable (false) logging'),
        }),
      },
    );
  }

  // ===== Profile Tools =====

  private createGetProfileTool(chatId: string) {
    return tool(
      () => {
        const soul = this.soulService.getSoulData(chatId);
        if (!soul) {
          return 'No profile found. Please complete the initial setup by sending /start.';
        }

        return JSON.stringify(
          {
            aiName: soul.aiName,
            aiPersonality: soul.aiCharacter,
            aiEmoji: soul.aiEmoji || '🤖',
            userName: soul.userName,
            userDescription: soul.userDescription,
            additionalContext: soul.additionalContext || 'None',
          },
          null,
          2,
        );
      },
      {
        name: 'getProfile',
        description:
          "Get the current profile settings including AI name, personality, signature emoji, and user information. Use this when the user asks about their profile or the AI's settings.",
      },
    );
  }

  private createUpdateProfileTool(chatId: string) {
    return tool(
      async (input: {
        aiName?: string;
        aiPersonality?: string;
        aiEmoji?: string;
        userName?: string;
        userDescription?: string;
        additionalContext?: string;
      }) => {
        const soul = this.soulService.getSoulData(chatId);
        if (!soul) {
          return 'Error: No profile found. Please complete the initial setup first.';
        }

        const updates: Record<string, string> = {};
        const changes: string[] = [];

        // Handle AI name update
        if (input.aiName) {
          updates.aiName = input.aiName;
          changes.push(`AI name: "${soul.aiName}" → "${input.aiName}"`);
        }

        // Handle AI personality update (with AI refinement)
        if (input.aiPersonality) {
          const refined = await this.aiService.refineSoulData({
            ...soul,
            aiCharacter: input.aiPersonality,
          });
          updates.aiCharacter = refined.aiCharacter;
          changes.push(`AI personality: "${soul.aiCharacter}" → "${refined.aiCharacter}"`);
        }

        // Handle AI emoji update
        if (input.aiEmoji) {
          // Convert to emoji (handles both direct emoji and descriptions)
          const emoji = await this.aiService.convertToEmoji(input.aiEmoji);
          updates.aiEmoji = emoji;
          changes.push(`AI emoji: "${soul.aiEmoji || '🤖'}" → "${emoji}"`);
        }

        // Handle user name update
        if (input.userName) {
          updates.userName = input.userName;
          changes.push(`User name: "${soul.userName}" → "${input.userName}"`);
        }

        // Handle user description update (with AI refinement)
        if (input.userDescription) {
          const refined = await this.aiService.refineSoulData({
            ...soul,
            userDescription: input.userDescription,
          });
          updates.userDescription = refined.userDescription;
          changes.push(`User description updated`);
        }

        // Handle additional context update (with AI refinement)
        if (input.additionalContext) {
          const refined = await this.aiService.refineSoulData({
            ...soul,
            additionalContext: input.additionalContext,
          });
          updates.additionalContext = refined.additionalContext;
          changes.push(`Additional context updated`);
        }

        if (changes.length === 0) {
          return 'No changes provided. You can update: aiName, aiPersonality, aiEmoji, userName, userDescription, or additionalContext.';
        }

        this.soulService.updateSoulData(chatId, updates);
        this.agentLogger.info(LogEvent.TOOL_RESULT, `Profile updated: ${changes.join(', ')}`, { chatId });

        return `Profile updated:\n${changes.map((c) => `• ${c}`).join('\n')}`;
      },
      {
        name: 'updateProfile',
        description:
          'Update user profile settings. Can update AI name, AI personality, signature emoji, user name, user description, or additional context. Use this when the user wants to change any profile settings.',
        schema: z.object({
          aiName: z.string().optional().describe('New name for the AI assistant'),
          aiPersonality: z.string().optional().describe('New personality/style for the AI (e.g., "friendly", "professional", "concise")'),
          aiEmoji: z.string().optional().describe('New signature emoji for the AI (e.g., "🚀", "🌟", "🤖")'),
          userName: z.string().optional().describe("The user's name"),
          userDescription: z.string().optional().describe('Description about the user'),
          additionalContext: z.string().optional().describe('Additional context or preferences for the AI to remember'),
        }),
      },
    );
  }

  // ===== Scheduler Tools =====

  private createScheduleTool(chatId: string) {
    return tool(
      (input: {
        description: string;
        taskContext: string;
        executeAt?: string;
        cronExpression?: string;
        maxExecutions?: number;
      }) => {
        // Validate that at least one time specification is provided
        if (!input.executeAt && !input.cronExpression) {
          return 'Error: You must provide either executeAt (for one-time tasks) or cronExpression (for recurring tasks).';
        }

        // Validate the time specifications
        if (input.executeAt) {
          const executeDate = new Date(input.executeAt);
          if (isNaN(executeDate.getTime())) {
            return `Error: Invalid executeAt date format. Please use ISO format (e.g., "2024-12-25T09:00:00").`;
          }
          if (executeDate <= new Date()) {
            return 'Error: The scheduled time must be in the future.';
          }
        }

        if (input.cronExpression) {
          const parts = input.cronExpression.trim().split(/\s+/);
          if (parts.length !== 5) {
            return 'Error: Invalid cron expression. Format: "minute hour dayOfMonth month dayOfWeek" (e.g., "30 9 * * 1" for 9:30 AM every Monday).';
          }
        }

        try {
          const result = this.schedulerService.createJob({
            chatId,
            description: input.description,
            taskContext: input.taskContext,
            executeAt: input.executeAt,
            cronExpression: input.cronExpression,
            maxExecutions: input.maxExecutions,
          });

          // Check if this is a duplicate
          if ('duplicate' in result && result.duplicate) {
            const existingJob = result.existingJob;
            this.agentLogger.warn(LogEvent.TOOL_RESULT, `Duplicate schedule detected, existing: ${existingJob.id}`, { chatId });

            let scheduleInfo = '';
            if (existingJob.scheduleType === 'once' && existingJob.executeAt) {
              scheduleInfo = `Scheduled for: ${new Date(existingJob.executeAt).toLocaleString()}`;
            } else if (existingJob.cronExpression) {
              scheduleInfo = `Recurring schedule: ${existingJob.cronExpression}`;
            }

            return `⚠️ A similar schedule already exists!\n\nID: ${existingJob.id}\nDescription: ${existingJob.description}\n${scheduleInfo}\n\nNo new schedule was created to avoid duplication.`;
          }

          // At this point, result is a ScheduledJob (not a duplicate)
          const job = result as import('../scheduler/scheduler.service').ScheduledJob;
          this.agentLogger.info(LogEvent.TOOL_RESULT, `Schedule created: ${job.id}`, { chatId });

          let scheduleInfo = '';
          if (job.scheduleType === 'once' && job.executeAt) {
            scheduleInfo = `Scheduled for: ${new Date(job.executeAt).toLocaleString()}`;
          } else if (job.cronExpression) {
            scheduleInfo = `Recurring schedule: ${job.cronExpression}`;
            if (job.maxExecutions) {
              scheduleInfo += ` (will run ${job.maxExecutions} time${job.maxExecutions > 1 ? 's' : ''})`;
            }
          }

          return `✅ Schedule created successfully!\n\nID: ${job.id}\nDescription: ${job.description}\n${scheduleInfo}`;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.agentLogger.error(LogEvent.TOOL_ERROR, `Failed to create schedule: ${errorMsg}`, { chatId });
          return `Error creating schedule: ${errorMsg}`;
        }
      },
      {
        name: 'createSchedule',
        description: `Schedule a reminder or task for the user. Use this when the user wants to be reminded about something or schedule a recurring task.

**IMPORTANT - Ask for details when context is incomplete:**
Before creating a schedule, you MUST have enough context to know EXACTLY what to do when the task runs.
If the user's request is vague or lacks specific details, DO NOT create the schedule. Instead, ask clarifying questions first.

Examples of INCOMPLETE requests (DO NOT schedule these - ask for details):
- "Schedule a morning brief" → Ask: What should the morning brief include? (news, weather, calendar, tasks, etc.)
- "Remind me about exercise" → Ask: What kind of reminder? (start workout, take a break, drink water?)
- "Send me updates daily" → Ask: Updates about what? (weather, stocks, news topics?)
- "Schedule a weekly report" → Ask: What should be in the report?

Examples of COMPLETE requests (OK to schedule):
- "Send me a Persian poem every morning at 8am"
- "Remind me to call mom every Sunday at 5pm"
- "Every day at 9am, tell me the weather in Gothenburg and my calendar events"
- "Every Friday at 6pm, remind me: weekend shopping list"

For ONE-TIME tasks: Use executeAt with an ISO date string (e.g., "2024-12-25T09:00:00").
For RECURRING tasks: Use cronExpression with a cron format "minute hour dayOfMonth month dayOfWeek":
  - "0 9 * * *" = Every day at 9:00 AM
  - "30 9 * * 1" = Every Monday at 9:30 AM
  - "0 9 * * 1-5" = Weekdays at 9:00 AM
  - "0 9,18 * * *" = Every day at 9:00 AM and 6:00 PM

Use maxExecutions to limit how many times a recurring task runs (e.g., 10 for "remind me 10 times").`,
        schema: z.object({
          description: z.string().describe('Short summary of the task (e.g., "Send a Persian poem", "Remind about meeting")'),
          taskContext: z.string().describe('The SPECIFIC request to execute when task runs. Must contain clear, actionable instructions. If the user did not provide enough detail, DO NOT fill this in with assumptions - ask them first.'),
          executeAt: z.string().optional().describe('ISO date string for one-time execution (e.g., "2024-12-25T09:00:00")'),
          cronExpression: z.string().optional().describe('Cron expression for recurring tasks (e.g., "0 9 * * 1" for 9 AM every Monday)'),
          maxExecutions: z.number().optional().describe('Maximum number of times to execute (for recurring tasks). Omit for unlimited.'),
        }),
      },
    );
  }

  private createListSchedulesTool(chatId: string) {
    return tool(
      () => {
        const jobs = this.schedulerService.getActiveJobsForChat(chatId);

        if (jobs.length === 0) {
          return 'You have no active scheduled tasks.';
        }

        const jobsList = jobs.map((job) => this.schedulerService.formatJobForDisplay(job)).join('\n\n---\n\n');

        this.agentLogger.info(LogEvent.TOOL_RESULT, `Listed ${jobs.length} schedules`, { chatId });

        return `📋 *Your Active Schedules (${jobs.length}):*\n\n${jobsList}`;
      },
      {
        name: 'listSchedules',
        description: 'List all active scheduled tasks and reminders for the user. Use this when the user wants to see their scheduled items.',
      },
    );
  }

  private createCancelScheduleTool(chatId: string) {
    return tool(
      (input: { jobId: string }) => {
        const job = this.schedulerService.getJob(input.jobId);

        if (!job) {
          return `Error: Schedule with ID "${input.jobId}" not found.`;
        }

        if (job.chatId !== chatId) {
          return `Error: You don't have permission to cancel this schedule.`;
        }

        if (job.status !== 'active') {
          return `Error: This schedule is already ${job.status}.`;
        }

        const success = this.schedulerService.cancelJob(input.jobId, chatId);

        if (success) {
          this.agentLogger.info(LogEvent.TOOL_RESULT, `Schedule cancelled: ${input.jobId}`, { chatId });
          return `✅ Schedule "${job.description}" has been cancelled.`;
        }

        return 'Error: Failed to cancel the schedule. Please try again.';
      },
      {
        name: 'cancelSchedule',
        description: 'Cancel an active scheduled task or reminder. Use this when the user wants to remove a scheduled item.',
        schema: z.object({
          jobId: z.string().describe('The ID of the schedule to cancel (get this from listSchedules)'),
        }),
      },
    );
  }

  // ===== Browser Automation Tools =====

  private createExecuteBrowserTaskTool(chatId: string) {
    return tool(
      async (input: { task: string }): Promise<[string, { screenshots: string[] }]> => {
        this.agentLogger.info(LogEvent.TOOL_EXECUTING, `Browser task: ${input.task}`, { chatId });

        try {
          const result = await this.browserAgentService.executeTask(input.task, chatId);

          this.agentLogger.info(
            result.success ? LogEvent.TOOL_RESULT : LogEvent.TOOL_ERROR,
            `Browser task ${result.success ? 'completed' : 'failed'}: ${result.stepsCompleted}/${result.totalSteps} steps`,
            { chatId },
          );

          // Format the result for the agent (text only; screenshots go in artifact)
          let response = result.summary;

          if (result.data && result.data.length > 0) {
            response += '\n\n**Extracted Data:**\n';
            for (const item of result.data) {
              if (item.text) {
                // Truncate long text
                const text = item.text.length > 500 ? item.text.slice(0, 500) + '...' : item.text;
                response += `\n${item.description || 'Data'}:\n${text}\n`;
              }
            }
          }

          if (!result.success && result.error) {
            response += `\n\n**Error:** ${result.error}`;
          }

          // Return [content, artifact] so ToolMessage gets text + screenshots
          const screenshots = result.screenshots ?? [];
          return [response, { screenshots }];
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.agentLogger.error(LogEvent.TOOL_ERROR, `Browser task failed: ${errorMsg}`, { chatId });
          return [`Browser task failed: ${errorMsg}`, { screenshots: [] }];
        }
      },
      {
        name: 'executeBrowserTask',
        responseFormat: 'content_and_artifact' as const,
        description: `Execute a browser automation task. Use this when the user asks to visit a website, take a screenshot, or interact with web pages.

IMPORTANT: Pass the user's request EXACTLY as they stated it. Do NOT add extra instructions or interpret what they might want. Only include what the user explicitly asked for.

Examples:
- User says "go to bonbast.com" → task: "go to bonbast.com"
- User says "take a screenshot of google.com" → task: "take a screenshot of google.com"
- User says "go to example.com, wait 5 seconds, take screenshot" → task: "go to example.com, wait 5 seconds, take screenshot"`,
        schema: z.object({
          task: z.string().describe('The EXACT browser task as stated by the user. Do not add or interpret - pass exactly what was requested.'),
        }),
      },
    );
  }
}
