/**
 * Defines the tools the MAIN AGENT can call. Provides getProfile,
 * updateProfile, createSchedule, listSchedules, cancelSchedule, httpRequest, executeBrowserTask,
 * memorySearch, memorySave, and notepad tools (listNotepads, readNotepad, updateNotepad).
 * When the main agent calls executeBrowserTask(task), this service invokes the
 * Browser Agent (BrowserAgentService) and returns summary + screenshots as a
 * content_and_artifact ToolMessage. When the main agent calls executeCoderTask(task),
 * this service starts the Coder Agent in the background and returns immediately;
 * progress is sent to the user via Telegram. httpRequest performs curl-like HTTP calls.
 * memorySearch and memorySave provide access to the two-layer memory system.
 * Notepad tools provide generic persistent memory for tracking data across runs.
 * Does not run any agent loop itself.
 */
import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { tool } from '@langchain/core/tools';
import { ConfigService } from '../config/config.service';
import { AgentLoggerService, LogEvent } from '../logger/agent-logger.service';
import { SoulService } from '../soul/soul.service';
import { AiService } from '../ai/ai.service';
import { SchedulerService } from '../scheduler/scheduler.service';
import { BrowserAgentService } from '../browser/browser-agent.service';
import { CoderAgentService } from '../coder/coder-agent.service';
import { BrowserMCPAgentService } from '../browser-mcp/browser-mcp-agent.service';
import { MemoryService } from '../memory/memory.service';
import { NotepadService } from '../notepad/notepad.service';
import { FileToolsService } from '../file/file-tools.service';
import { MemoryCategory } from '../memory/memory.types';
import { validateUrlForSsrf } from '../utils/input-sanitizer';
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
    private readonly coderAgentService: CoderAgentService,
    private readonly browserMCPAgentService: BrowserMCPAgentService,
    private readonly memoryService: MemoryService,
    private readonly notepadService: NotepadService,
    @Inject(forwardRef(() => FileToolsService))
    private readonly fileToolsService: FileToolsService,
  ) { }

  /**
   * Get all available local tools (without chat context)
   */
  getLocalTools(): Record<string, any> {
    return {
      setLogging: this.createSetLoggingTool(),
    };
  }

  /**
   * Get tools that require chat context (for updating user profile)
   */
  getToolsForChat(chatId: string): Record<string, any> {
    // Get file tools for this chat
    const fileTools = this.fileToolsService.getToolsForChat(chatId);

    return {
      ...this.getLocalTools(),
      getProfile: this.createGetProfileTool(chatId),
      updateProfile: this.createUpdateProfileTool(chatId),
      createSchedule: this.createScheduleTool(chatId),
      listSchedules: this.createListSchedulesTool(chatId),
      listInactiveSchedules: this.createListInactiveSchedulesTool(chatId),
      cancelSchedule: this.createCancelScheduleTool(chatId),
      updateSchedule: this.createUpdateScheduleTool(chatId),
      reactivateSchedule: this.createReactivateScheduleTool(chatId),
      executeBrowserTask: this.createExecuteBrowserTaskTool(chatId),
      executeBrowserMCPTask: this.createExecuteBrowserMCPTaskTool(chatId),
      continueBrowserMCPTask: this.createContinueBrowserMCPTaskTool(chatId),
      executeCoderTask: this.createExecuteCoderTaskTool(chatId),
      listCoderProjects: this.createListCoderProjectsTool(chatId),
      switchCoderProject: this.createSwitchCoderProjectTool(chatId),
      httpRequest: this.createHttpRequestTool(chatId),
      memorySearch: this.createMemorySearchTool(chatId),
      memorySave: this.createMemorySaveTool(chatId),
      // Generic notepad tools for persistent data tracking
      listNotepads: this.createListNotepadsTool(chatId),
      readNotepad: this.createReadNotepadTool(chatId),
      updateNotepad: this.createUpdateNotepadTool(chatId),
      deleteNotepad: this.createDeleteNotepadTool(chatId),
      // File management tools
      ...fileTools,
    };
  }

  // ===== Basic Tools =====

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
          `Update user profile settings. Can update AI name, AI personality, signature emoji, user name, user description, or additional context.

IMPORTANT: additionalContext is for STATIC preferences and background info ONLY (e.g., "prefers formal tone", "works in tech").
DO NOT use additionalContext for:
- Schedule/task status (use createSchedule/listSchedules)
- Runtime state like "last BTC price" (use schedule notepad for scheduled tasks)
- Anything that changes frequently or should expire`,
        schema: z.object({
          aiName: z.string().optional().describe('New name for the AI assistant'),
          aiPersonality: z.string().optional().describe('New personality/style for the AI (e.g., "friendly", "professional", "concise")'),
          aiEmoji: z.string().optional().describe('New signature emoji for the AI (e.g., "🚀", "🌟", "🤖")'),
          userName: z.string().optional().describe("The user's name"),
          userDescription: z.string().optional().describe('Description about the user'),
          additionalContext: z.string().optional().describe('Static preferences or background info ONLY. NOT for schedules, tasks, or runtime state.'),
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
        useGeniusModel?: boolean;
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
            useGeniusModel: input.useGeniusModel,
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
        description: `Schedule a reminder or task for the user. ONLY use this tool when the user EXPLICITLY requests to create a schedule/reminder/task.

**CRITICAL - EXPLICIT REQUEST REQUIRED:**
The user MUST explicitly ask you to create a schedule using words like:
- "remind me", "set a reminder", "create a reminder"
- "schedule", "create a schedule", "set up a task"
- "notify me", "alert me", "let me know at [time]"
- "every [day/morning/week]", "at [time] do X"

**DO NOT create schedules when:**
- User is just asking a question (e.g., "what's the bitcoin price?" does NOT mean "schedule bitcoin price checks")
- User is having a conversation about a topic (talking about weather ≠ scheduling weather updates)
- The context from previous messages seems related but user didn't ask for a schedule
- You're guessing or inferring that user might want a schedule

**IMPORTANT - Don't guess the task content:**
The task description and context must come DIRECTLY from what the user said. Do NOT:
- Assume the task is about the previous conversation topic
- Fill in details the user didn't provide
- Infer what the user "probably" wants based on recent questions

**Ask for clarification when details are missing:**
If the user asks for a schedule but doesn't provide enough detail, ask them:
- What should the reminder/task be about?
- What time/frequency?
- What specific action should be performed?

Examples of VALID schedule requests:
- "Remind me to call mom every Sunday at 5pm" → OK: explicit request with clear task
- "Every morning at 8am, send me a Persian poem" → OK: explicit schedule request
- "Set a reminder for tomorrow at 9am to check the meeting agenda" → OK: explicit

Examples of INVALID (do NOT schedule):
- User asks "what's bitcoin price?" then later "can you check that regularly?" → Ask: "Do you want me to schedule regular bitcoin price checks? If so, how often?"
- User discusses weather, then says "that would be useful to know" → Ask: "Would you like me to schedule weather updates? What time and how often?"
- User says "morning updates would be nice" → Ask: "What would you like included in the morning updates, and what time?"

For ONE-TIME tasks: Use executeAt with an ISO date string (e.g., "2024-12-25T09:00:00").
For RECURRING tasks: Use cronExpression with a cron format "minute hour dayOfMonth month dayOfWeek":
  - "0 9 * * *" = Every day at 9:00 AM
  - "30 9 * * 1" = Every Monday at 9:30 AM
  - "0 9 * * 1-5" = Weekdays at 9:00 AM
  - "0 9,18 * * *" = Every day at 9:00 AM and 6:00 PM

Use maxExecutions to limit how many times a recurring task runs (e.g., 10 for "remind me 10 times").

**GENIUS MODE (useGeniusModel):**
Set useGeniusModel=true ONLY when the user explicitly requests enhanced reasoning. Look for phrases like:
- "use genius mode", "use smart mode", "use genius model"
- "use enhanced reasoning", "use the smart model"
- "with deep analysis", "with advanced reasoning"

Default is FALSE (uses standard model). Genius mode is expensive, so only enable when user explicitly asks.

Examples:
- "Schedule stock analysis every morning, use genius mode" → useGeniusModel: true
- "Schedule stock analysis every morning" → useGeniusModel: false (default)
- "Remind me with smart reasoning to analyze trends" → useGeniusModel: true`,
        schema: z.object({
          description: z.string().describe('Short summary of the task (e.g., "Send a Persian poem", "Remind about meeting")'),
          taskContext: z.string().describe('The SPECIFIC request to execute when task runs. Must contain clear, actionable instructions. If the user did not provide enough detail, DO NOT fill this in with assumptions - ask them first.'),
          executeAt: z.string().optional().describe('ISO date string for one-time execution (e.g., "2024-12-25T09:00:00")'),
          cronExpression: z.string().optional().describe('Cron expression for recurring tasks (e.g., "0 9 * * 1" for 9 AM every Monday)'),
          maxExecutions: z.number().optional().describe('Maximum number of times to execute (for recurring tasks). Omit for unlimited.'),
          useGeniusModel: z.boolean().optional().describe('Enable genius model. Default: false. Only set true when user explicitly says "genius mode", "smart mode", "enhanced reasoning", etc.'),
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
        description: 'List all active scheduled tasks and reminders for this user (reads from storage). ALWAYS call this when the user asks about current/active schedules (e.g. "any 8am task?", "what\'s scheduled?", "are there any?", "what about now?" in schedule context). Do not answer from conversation memory—always use this tool to get the current list.',
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
        description: `Cancel an active scheduled task or reminder. ONLY use when the user EXPLICITLY asks to cancel/remove/delete a schedule.

**EXPLICIT REQUEST REQUIRED:**
User must say things like: "cancel", "remove", "delete", "stop", "turn off", "disable" a schedule/reminder/task.

**DO NOT cancel when:**
- User is just asking about schedules (listing them is not canceling them)
- User expresses mild dissatisfaction (ask for confirmation first)
- You think the schedule might not be needed anymore

**ALWAYS confirm before canceling** if:
- User's request is ambiguous (e.g., "I don't need that anymore" - ask which one)
- Multiple schedules could match the description (list them and ask which to cancel)`,
        schema: z.object({
          jobId: z.string().describe('The ID of the schedule to cancel (get this from listSchedules)'),
        }),
      },
    );
  }

  private createUpdateScheduleTool(chatId: string) {
    return tool(
      (input: {
        jobId: string;
        description?: string;
        taskContext?: string;
        executeAt?: string;
        cronExpression?: string;
        maxExecutions?: number;
        useGeniusModel?: boolean;
      }) => {
        const job = this.schedulerService.getJob(input.jobId);

        if (!job) {
          return `Error: Schedule with ID "${input.jobId}" not found.`;
        }

        if (job.chatId !== chatId) {
          return `Error: You don't have permission to update this schedule.`;
        }

        if (job.status !== 'active') {
          return `Error: Cannot update a ${job.status} schedule. Only active schedules can be updated.`;
        }

        // Validate executeAt if provided
        if (input.executeAt) {
          const executeDate = new Date(input.executeAt);
          if (isNaN(executeDate.getTime())) {
            return `Error: Invalid executeAt date format. Please use ISO format (e.g., "2024-12-25T09:00:00").`;
          }
          if (executeDate <= new Date()) {
            return 'Error: The scheduled time must be in the future.';
          }
        }

        // Validate cronExpression if provided
        if (input.cronExpression) {
          const parts = input.cronExpression.trim().split(/\s+/);
          if (parts.length !== 5) {
            return 'Error: Invalid cron expression. Format: "minute hour dayOfMonth month dayOfWeek".';
          }
        }

        const updates: {
          description?: string;
          taskContext?: string;
          executeAt?: string;
          cronExpression?: string;
          maxExecutions?: number;
          useGeniusModel?: boolean;
        } = {};

        if (input.description) updates.description = input.description;
        if (input.taskContext) updates.taskContext = input.taskContext;
        if (input.executeAt) updates.executeAt = input.executeAt;
        if (input.cronExpression) updates.cronExpression = input.cronExpression;
        if (input.maxExecutions !== undefined) updates.maxExecutions = input.maxExecutions;
        if (input.useGeniusModel !== undefined) updates.useGeniusModel = input.useGeniusModel;

        if (Object.keys(updates).length === 0) {
          return 'No updates provided. You can update: description, taskContext, executeAt, cronExpression, maxExecutions, or useGeniusModel.';
        }

        const updatedJob = this.schedulerService.updateJob(input.jobId, chatId, updates);

        if (!updatedJob) {
          return 'Error: Failed to update the schedule. Please check the provided values.';
        }

        this.agentLogger.info(LogEvent.TOOL_RESULT, `Schedule updated: ${input.jobId}`, { chatId });

        let scheduleInfo = '';
        if (updatedJob.scheduleType === 'once' && updatedJob.executeAt) {
          scheduleInfo = `Scheduled for: ${new Date(updatedJob.executeAt).toLocaleString()}`;
        } else if (updatedJob.cronExpression) {
          scheduleInfo = `Recurring schedule: ${updatedJob.cronExpression}`;
          if (updatedJob.maxExecutions) {
            scheduleInfo += ` (${updatedJob.executionCount}/${updatedJob.maxExecutions} executions)`;
          }
        }

        return `✅ Schedule updated successfully!\n\nID: ${updatedJob.id}\nDescription: ${updatedJob.description}\n${scheduleInfo}`;
      },
      {
        name: 'updateSchedule',
        description: `Update an existing active schedule without canceling and recreating it. Use when the user wants to:
- Change the description or task content of an existing schedule
- Change the timing (executeAt or cronExpression)
- Modify the max executions limit
- Enable/disable genius mode

This is more efficient than canceling and creating a new schedule because:
- It preserves the schedule's notepad (data history, notes)
- It keeps the same job ID
- It's a single operation

**EXPLICIT REQUEST REQUIRED:**
User must explicitly ask to update/modify/change a schedule.

**Genius mode toggle:**
- User says "enable genius mode on my stock schedule" → useGeniusModel: true
- User says "turn off smart mode for that task" → useGeniusModel: false`,
        schema: z.object({
          jobId: z.string().describe('The ID of the schedule to update (get this from listSchedules)'),
          description: z.string().optional().describe('New description for the schedule'),
          taskContext: z.string().optional().describe('New task context/instructions for the schedule'),
          executeAt: z.string().optional().describe('New execution time for one-time schedules (ISO format). This will convert a recurring schedule to one-time.'),
          cronExpression: z.string().optional().describe('New cron expression for recurring schedules (e.g., "0 9 * * *"). This will convert a one-time schedule to recurring.'),
          maxExecutions: z.number().optional().describe('New maximum number of executions for recurring tasks'),
          useGeniusModel: z.boolean().optional().describe('Enable/disable genius mode for this schedule'),
        }),
      },
    );
  }

  private createListInactiveSchedulesTool(chatId: string) {
    return tool(
      () => {
        const jobs = this.schedulerService.getInactiveJobsForChat(chatId);

        if (jobs.length === 0) {
          return 'You have no inactive (cancelled or completed) scheduled tasks.';
        }

        const jobsList = jobs.map((job) => this.schedulerService.formatJobForDisplay(job)).join('\n\n---\n\n');

        this.agentLogger.info(LogEvent.TOOL_RESULT, `Listed ${jobs.length} inactive schedules`, { chatId });

        return `📋 *Your Inactive Schedules (${jobs.length}):*\n\n${jobsList}\n\n💡 Use reactivateSchedule to reactivate any of these.`;
      },
      {
        name: 'listInactiveSchedules',
        description: 'List all inactive (cancelled or completed) scheduled tasks. Use when the user asks about old/past/cancelled/completed schedules or wants to see what schedules they can reactivate.',
      },
    );
  }

  private createReactivateScheduleTool(chatId: string) {
    return tool(
      (input: { jobId: string; newExecuteAt?: string }) => {
        const job = this.schedulerService.getJob(input.jobId);

        if (!job) {
          return `Error: Schedule with ID "${input.jobId}" not found.`;
        }

        if (job.chatId !== chatId) {
          return `Error: You don't have permission to reactivate this schedule.`;
        }

        if (job.status === 'active') {
          return `This schedule is already active.`;
        }

        // For one-time jobs that have passed, require a new time
        if (job.scheduleType === 'once' && job.executeAt) {
          const oldTime = new Date(job.executeAt);
          if (oldTime <= new Date() && !input.newExecuteAt) {
            return `Error: This was a one-time schedule for ${oldTime.toLocaleString()} which has already passed. Please provide a new execution time (newExecuteAt) to reactivate it.`;
          }
        }

        const success = this.schedulerService.reactivateJob(input.jobId, chatId, input.newExecuteAt);

        if (success) {
          const updatedJob = this.schedulerService.getJob(input.jobId);
          this.agentLogger.info(LogEvent.TOOL_RESULT, `Schedule reactivated: ${input.jobId}`, { chatId });

          let response = `✅ Schedule "${job.description}" has been reactivated.`;
          if (updatedJob?.scheduleType === 'once' && updatedJob.executeAt) {
            response += `\nScheduled for: ${new Date(updatedJob.executeAt).toLocaleString()}`;
          }
          return response;
        }

        return 'Error: Failed to reactivate the schedule. For one-time schedules with past execution times, provide a new time using the newExecuteAt parameter.';
      },
      {
        name: 'reactivateSchedule',
        description: `Reactivate a cancelled or completed schedule. Use when the user wants to re-enable a previously cancelled or completed task.

**EXPLICIT REQUEST REQUIRED:**
User must explicitly ask to reactivate/re-enable/restart a schedule.

**For one-time schedules:**
If the original execution time has passed, you MUST provide a new execution time using the newExecuteAt parameter (ISO format).

**For recurring schedules:**
Can be reactivated without a new time - they will resume on their normal schedule.`,
        schema: z.object({
          jobId: z.string().describe('The ID of the schedule to reactivate (get this from listInactiveSchedules)'),
          newExecuteAt: z.string().optional().describe('New execution time for one-time schedules (ISO format, e.g., "2024-12-25T09:00:00"). Required if the original time has passed.'),
        }),
      },
    );
  }

  // ===== HTTP Request Tool =====

  private createHttpRequestTool(chatId: string) {
    return tool(
      async (input: {
        method: string;
        url: string;
        headers?: Record<string, string>;
        queryParams?: Record<string, string | number>;
        body?: string | Record<string, unknown>;
      }) => {
        try {
          // SSRF protection: validate URL before making request
          const ssrfError = validateUrlForSsrf(input.url);
          if (ssrfError) {
            this.agentLogger.warn(LogEvent.TOOL_ERROR, `httpRequest blocked: ${ssrfError}`, { chatId });
            return `Error: ${ssrfError}`;
          }

          const url = new URL(input.url);
          if (input.queryParams && Object.keys(input.queryParams).length > 0) {
            for (const [key, value] of Object.entries(input.queryParams)) {
              url.searchParams.set(key, String(value));
            }
          }

          const headers = new Headers(input.headers ?? {});
          let body: string | undefined;
          if (input.body !== undefined && input.body !== null && input.body !== '') {
            if (typeof input.body === 'string') {
              body = input.body;
            } else {
              if (!headers.has('Content-Type')) {
                headers.set('Content-Type', 'application/json');
              }
              body = JSON.stringify(input.body);
            }
          }

          const response = await fetch(url.toString(), {
            method: input.method,
            headers,
            body: ['GET', 'HEAD'].includes(input.method) ? undefined : body,
          });

          const contentType = response.headers.get('content-type') ?? '';
          let responseBody: string;
          if (contentType.includes('application/json')) {
            try {
              responseBody = JSON.stringify(await response.json(), null, 2);
            } catch {
              responseBody = await response.text();
            }
          } else {
            responseBody = await response.text();
          }

          const summary = `HTTP ${response.status} ${response.statusText}\n${responseBody}`;
          this.agentLogger.info(
            response.ok ? LogEvent.TOOL_RESULT : LogEvent.TOOL_ERROR,
            `httpRequest: ${input.method} ${input.url} → ${response.status}`,
            { chatId },
          );
          return summary;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.agentLogger.error(LogEvent.TOOL_ERROR, `httpRequest failed: ${errorMsg}`, { chatId });
          return `Error: ${errorMsg}`;
        }
      },
      {
        name: 'httpRequest',
        description: `Make an HTTP request (like curl). Use by DEFAULT for checking or fetching any URL: RSS feeds, APIs, web pages, or any endpoint. Use when the user or a scheduled task asks to call an API, fetch a URL, check a feed, or send data to an endpoint. Only use executeBrowserTask when the user explicitly asks to use the browser.

Supports: method (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS), url, optional headers, optional query params, optional body.
- For JSON APIs: use body as an object; Content-Type: application/json is set automatically if not provided.
- User can ask to add headers (e.g. Authorization, API keys, custom headers).`,
        schema: z.object({
          method: z
            .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
            .describe('HTTP method'),
          url: z.string().describe('Full URL (e.g. https://api.example.com/data)'),
          headers: z
            .record(z.string(), z.string())
            .optional()
            .describe('Optional request headers (e.g. { "Authorization": "Bearer token", "X-Custom": "value" })'),
          queryParams: z
            .record(z.string(), z.union([z.string(), z.number()]))
            .optional()
            .describe('Optional query parameters to append to the URL'),
          body: z
            .union([z.string(), z.record(z.string(), z.unknown())])
            .optional()
            .describe('Optional request body. Use object for JSON; string for raw body.'),
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
        description: `Execute a browser automation task. Use ONLY when the user explicitly asks to use the browser (e.g. "open in browser", "use the browser", "take a screenshot", "visit ... in browser") or when they need to interact with a page (click, type, fill forms, see the page visually). For simply checking or fetching a URL (RSS, API, feed, or page content), use httpRequest instead.

IMPORTANT: Pass the user's request EXACTLY as they stated it. Do NOT add extra instructions or interpret what they might want. Only include what the user explicitly asked for.

Examples (browser explicitly requested):
- User says "open bonbast.com in the browser" → task: "go to bonbast.com"
- User says "take a screenshot of google.com" → task: "take a screenshot of google.com"
- User says "use the browser to go to example.com" → task: "go to example.com"`,
        schema: z.object({
          task: z.string().describe('The EXACT browser task as stated by the user. Do not add or interpret - pass exactly what was requested.'),
        }),
      },
    );
  }

  // ===== Browser MCP Tools =====

  private createExecuteBrowserMCPTaskTool(chatId: string) {
    return tool(
      async (input: { task: string }): Promise<[string, { screenshots: string[] }]> => {
        this.agentLogger.info(LogEvent.TOOL_EXECUTING, `Browser MCP task: ${input.task}`, { chatId });

        try {
          const result = await this.browserMCPAgentService.executeTask(input.task, chatId);

          this.agentLogger.info(
            result.success ? LogEvent.TOOL_RESULT : LogEvent.TOOL_ERROR,
            `Browser MCP task ${result.success ? 'completed' : 'failed'}: ${result.stepsCompleted.length} steps`,
            { chatId },
          );

          // Format the result (text only; screenshots go in artifact)
          let response = '';

          if (result.needsUserInput) {
            // Agent needs user input to continue
            response = `🔄 **Browser MCP needs your input**\n\n`;
            response += `**Question:** ${result.question}\n\n`;
            response += `**Session ID:** \`${result.sessionId}\`\n\n`;
            response += `Please answer the question above. To continue, use continueBrowserMCPTask with the session ID and your answer.`;
            response += `\n\n**Steps completed so far:**\n`;
            for (const step of result.stepsCompleted) {
              response += `• ${step}\n`;
            }
          } else if (result.success) {
            response = `✅ **Browser MCP task completed**\n\n`;
            response += `**Summary:** ${result.summary}\n\n`;

            if (result.stepsCompleted.length > 0) {
              response += `**Steps completed:**\n`;
              for (const step of result.stepsCompleted.slice(-5)) {
                response += `• ${step}\n`;
              }
              if (result.stepsCompleted.length > 5) {
                response += `  ... and ${result.stepsCompleted.length - 5} more steps\n`;
              }
            }

            if (result.extractedData && result.extractedData.length > 0) {
              response += `\n**Extracted Data:**\n`;
              for (const data of result.extractedData) {
                const preview = typeof data.data === 'string'
                  ? data.data.slice(0, 300)
                  : JSON.stringify(data.data).slice(0, 300);
                response += `• ${data.tool}: ${preview}${preview.length >= 300 ? '...' : ''}\n`;
              }
            }
          } else {
            response = `❌ **Browser MCP task failed**\n\n`;
            response += `**Error:** ${result.error}\n\n`;

            if (result.stepsCompleted.length > 0) {
              response += `**Steps completed before failure:**\n`;
              for (const step of result.stepsCompleted.slice(-3)) {
                response += `• ${step}\n`;
              }
            }
          }

          // Filter screenshots to only include valid file paths (not fileid references)
          const rawScreenshots = result.screenshots ?? [];
          const validScreenshots = rawScreenshots.filter(
            (s) => s && !s.startsWith('fileid:') && (s.includes('/') || s.includes('\\')),
          );

          // Debug: log screenshot info
          this.agentLogger.debug(LogEvent.TOOL_RESULT, `Browser MCP screenshots - raw: ${rawScreenshots.length}, valid: ${validScreenshots.length}`, {
            chatId,
            data: { rawScreenshots, validScreenshots },
          });

          // Return [content, artifact] so ToolMessage gets text + screenshots
          return [response, { screenshots: validScreenshots }];
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.agentLogger.error(LogEvent.TOOL_ERROR, `Browser MCP task failed: ${errorMsg}`, { chatId });
          return [`Browser MCP task failed: ${errorMsg}`, { screenshots: [] }];
        }
      },
      {
        name: 'executeBrowserMCPTask',
        responseFormat: 'content_and_artifact' as const,
        description: `Execute a browser automation task using Browser MCP. This uses your ACTUAL browser (not headless) via the Browser MCP Chrome extension.

**WHEN TO USE THIS TOOL:**
Use when the user explicitly asks to use "Browser MCP" or needs to:
- Interact with their logged-in browser session (preserved cookies, auth, extensions)
- Automate tasks in their real browser
- Access sites that require their existing login

**PREREQUISITES:**
- Browser MCP Chrome extension must be installed
- User's browser must be open
- Extension must be connected

**INTERACTIVE MODE:**
This tool can pause and ask the user questions during execution when:
- It needs login credentials
- Multiple options are available and user preference is unclear
- Confirmation is needed before an action
- The task description is ambiguous

If the tool returns needsUserInput=true, relay the question to the user and use continueBrowserMCPTask with their answer.

**DIFFERENCE FROM executeBrowserTask:**
- executeBrowserTask: Uses headless Playwright browser (isolated, fresh session)
- executeBrowserMCPTask: Uses user's real browser (logged-in sessions, cookies, extensions)

**EXAMPLES:**
- "Use Browser MCP to check my Gmail" → uses logged-in session
- "Use my browser to purchase X on Amazon" → uses saved payment methods
- "Browser MCP: book a restaurant on OpenTable" → interactive, may ask for preferences`,
        schema: z.object({
          task: z.string().describe('The browser automation task to perform. Be descriptive about what should be accomplished.'),
        }),
      },
    );
  }

  private createContinueBrowserMCPTaskTool(chatId: string) {
    return tool(
      async (input: { sessionId: string; userInput: string }): Promise<[string, { screenshots: string[] }]> => {
        this.agentLogger.info(LogEvent.TOOL_EXECUTING, `Continue Browser MCP session: ${input.sessionId}`, { chatId });

        try {
          const result = await this.browserMCPAgentService.continueWithInput(input.sessionId, input.userInput);

          this.agentLogger.info(
            result.success ? LogEvent.TOOL_RESULT : LogEvent.TOOL_ERROR,
            `Browser MCP continuation ${result.success ? 'completed' : 'failed'}`,
            { chatId },
          );

          // Format similar to executeBrowserMCPTask (text only; screenshots go in artifact)
          let response = '';

          if (result.needsUserInput) {
            response = `🔄 **Browser MCP needs more input**\n\n`;
            response += `**Question:** ${result.question}\n\n`;
            response += `**Session ID:** \`${result.sessionId}\`\n\n`;
            response += `Please answer the question above to continue.`;
          } else if (result.success) {
            response = `✅ **Browser MCP task completed**\n\n`;
            response += `**Summary:** ${result.summary}\n\n`;

            if (result.stepsCompleted.length > 0) {
              response += `**Steps completed:**\n`;
              for (const step of result.stepsCompleted.slice(-5)) {
                response += `• ${step}\n`;
              }
            }

            if (result.extractedData && result.extractedData.length > 0) {
              response += `\n**Extracted Data:**\n`;
              for (const data of result.extractedData) {
                const preview = typeof data.data === 'string'
                  ? data.data.slice(0, 300)
                  : JSON.stringify(data.data).slice(0, 300);
                response += `• ${data.tool}: ${preview}\n`;
              }
            }
          } else {
            response = `❌ **Browser MCP task failed**\n\n`;
            response += `**Error:** ${result.error}`;
          }

          // Filter screenshots to only include valid file paths (not fileid references)
          const validScreenshots = (result.screenshots ?? []).filter(
            (s) => s && !s.startsWith('fileid:') && (s.includes('/') || s.includes('\\')),
          );

          // Return [content, artifact] so ToolMessage gets text + screenshots
          return [response, { screenshots: validScreenshots }];
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.agentLogger.error(LogEvent.TOOL_ERROR, `Browser MCP continuation failed: ${errorMsg}`, { chatId });
          return [`Failed to continue Browser MCP session: ${errorMsg}`, { screenshots: [] }];
        }
      },
      {
        name: 'continueBrowserMCPTask',
        responseFormat: 'content_and_artifact' as const,
        description: `Continue a Browser MCP session after the user provides input. Use this when executeBrowserMCPTask returned needsUserInput=true.

The user should have answered the question asked by the Browser MCP agent. Pass their answer along with the session ID to continue the task.`,
        schema: z.object({
          sessionId: z.string().describe('The session ID returned by executeBrowserMCPTask'),
          userInput: z.string().describe('The user\'s answer to the question asked by Browser MCP'),
        }),
      },
    );
  }

  // ===== Coder Tools =====

  private createExecuteCoderTaskTool(chatId: string) {
    return tool(
      async (input: { task: string; waitForResult?: boolean }): Promise<string> => {
        this.agentLogger.info(LogEvent.TOOL_EXECUTING, `Coder task: ${input.task.slice(0, 80)}...`, { chatId });

        // By default, run async to avoid Telegram timeout (90s limit)
        // Progress updates and final result will be sent to user via messaging
        // Only wait for result if explicitly requested (for short tasks or chained operations)
        if (!input.waitForResult) {
          // Fire and forget - task runs in background, user gets updates via messaging
          this.coderAgentService.runInBackground(chatId, input.task);
          this.agentLogger.info(LogEvent.TOOL_RESULT, 'Coder task started (async)', { chatId });
          return `⚙️ Started coding task. The user will receive progress updates and the final result via message when complete.\n\nTask: ${input.task.slice(0, 200)}`;
        }

        // Wait for result (for short tasks or when chaining with browser tasks)
        try {
          const result = await this.coderAgentService.executeTask(chatId, input.task);

          this.agentLogger.info(
            result.success ? LogEvent.TOOL_RESULT : LogEvent.TOOL_ERROR,
            `Coder task ${result.success ? 'completed' : 'failed'}: ${result.stepsCompleted.length} steps`,
            { chatId },
          );

          // Format the result for the main agent
          let response = '';

          if (result.success) {
            response = `✅ Coding task completed.\n\n**Project:** ${result.projectFolder}\n\n`;

            if (result.stepsCompleted.length > 0) {
              response += `**Steps completed:**\n`;
              // Show last 5 steps to keep it concise
              const recentSteps = result.stepsCompleted.slice(-5);
              for (const step of recentSteps) {
                response += `• ${step}\n`;
              }
              if (result.stepsCompleted.length > 5) {
                response += `  ... and ${result.stepsCompleted.length - 5} more steps\n`;
              }
            }

            response += `\n**Summary:**\n${result.summary}`;

            // If the coder agent has a question, indicate it
            if (result.hasQuestion) {
              response += `\n\n⚠️ **The coder agent needs clarification.** Please address the question above and provide more details.`;
            }

            // Include running processes info for coordination with other tools
            if (result.runningProcesses && result.runningProcesses.length > 0) {
              response += `\n\n**Running Processes:**\n`;
              for (const proc of result.runningProcesses) {
                const portInfo = proc.port ? ` on port ${proc.port}` : '';
                const urlInfo = proc.url ? ` (${proc.url})` : '';
                response += `• Process ${proc.id}: ${proc.command}${portInfo}${urlInfo} [${proc.status}]\n`;

                // Include recent logs so main agent can understand what happened (including any errors)
                if (proc.logs.length > 0) {
                  response += `  **Console output (last ${Math.min(proc.logs.length, 15)} lines):**\n`;
                  for (const log of proc.logs.slice(-15)) {
                    response += `    ${log}\n`;
                  }
                }
              }
              response += `\n💡 **IMPORTANT:** Review the console output above carefully for errors. If you see "Error", "error", "failed", stack traces, or warnings:\n`;
              response += `   1. TELL THE USER about the error before proceeding\n`;
              response += `   2. Offer to fix it\n`;
              response += `   If taking a screenshot and it shows an error overlay, call executeCoderTask("show me the latest process logs") to see what went wrong.`;
            }
          } else {
            response = `❌ Coding task failed.\n\n**Project:** ${result.projectFolder}\n\n`;
            if (result.error) {
              response += `**Error:** ${result.error}\n\n`;
            }
            if (result.stepsCompleted.length > 0) {
              response += `**Steps completed before failure:**\n`;
              for (const step of result.stepsCompleted.slice(-3)) {
                response += `• ${step}\n`;
              }
            }

            // Still show running processes if any started before failure
            if (result.runningProcesses && result.runningProcesses.length > 0) {
              response += `\n**Running Processes (started before failure):**\n`;
              for (const proc of result.runningProcesses) {
                response += `• ${proc.id}: ${proc.command} [${proc.status}]\n`;
                if (proc.logs.length > 0) {
                  response += `  Last output: ${proc.logs.slice(-3).join(' | ')}\n`;
                }
              }
            }
          }

          return response;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.agentLogger.error(LogEvent.TOOL_ERROR, `Coder task failed: ${errorMsg}`, { chatId });
          return `Coding task failed: ${errorMsg}`;
        }
      },
      {
        name: 'executeCoderTask',
        description: `Run a coding task. Use when the user asks to: clone a git repo, view or edit files, write code, review files or a GitHub PR, run commands in a project, start/stop dev servers, commit, push, or any coding-related work.

**EXECUTION MODE:**
By default, tasks run ASYNCHRONOUSLY - the user receives progress updates and the final result via messages.
Set waitForResult=true ONLY when you need the result for a follow-up action (e.g., starting a server then taking a screenshot).

**IMPORTANT - Project Folder Context:**
The coder agent works in a specific project folder. Before running a task:

1. **If the user mentions a specific project/folder by name** (e.g., "in my-app project", "switch to test-api"):
   → Use switchCoderProject first to set the correct project, then run the task.

2. **If the task seems unrelated to the current project context** (e.g., user asks about a React app but current project is a Python API):
   → ASK the user: "I'm currently working in [project-name]. Would you like me to continue there, or switch to a different project?"

3. **If the user asks a generic coding question** without specifying a project and you're unsure:
   → Use listCoderProjects to show available options and ask which one to use.

4. **For clone operations**: The coder automatically creates a new folder from the repo name.

5. **For continuing work**: If the task clearly relates to the current project, proceed directly.

**RUNNING SERVERS/DEV MODE:**
The coder can start long-running processes (npm run dev, npm start, etc.). When a process is started:
- The result will include the running process info (ID, port, URL, logs)
- You can then use executeBrowserTask to visit the running app
- Ask to stop the process when done

**COORDINATED WORKFLOWS:**
For "run the app and take a screenshot" type requests:
1. First call executeCoderTask with waitForResult=true to start the app
2. Check the result for runningProcesses with port/URL info - LOOK FOR ERRORS IN THE LOGS!
3. Then call executeBrowserTask to visit that URL and take a screenshot
4. **IMPORTANT:** If the screenshot shows an error overlay/message, call executeCoderTask("get the latest logs from running processes") to see what went wrong, then report to user.

**ERROR HANDLING:**
- ALWAYS carefully read the console logs in the response
- If you see Error, error, failed, warning, or stack traces - TELL THE USER
- Do NOT say "running successfully" if there are errors in the logs!`,
        schema: z.object({
          task: z.string().describe('The coding task as requested by the user (e.g. "clone https://github.com/foo/bar and add a README", "run npm run dev")'),
          waitForResult: z.boolean().optional().describe('Set to true when you need the result for a follow-up action (e.g., start server then screenshot). Default: false (runs async, user gets progress updates)'),
        }),
      },
    );
  }

  // ===== Coder Project Management Tools =====

  private createListCoderProjectsTool(chatId: string) {
    return tool(
      async () => {
        this.agentLogger.info(LogEvent.TOOL_EXECUTING, 'Listing coder projects', { chatId });

        const projects = await this.configService.listCoderProjects();
        const activeFolder = this.configService.getCoderActiveFolder(chatId);

        if (projects.length === 0) {
          return 'No project folders found. When you run a coding task, a project folder will be created automatically.';
        }

        let response = `📁 **Available Project Folders (${projects.length}):**\n\n`;
        for (const project of projects) {
          const isActive = project.name === activeFolder;
          const marker = isActive ? ' ← *current*' : '';
          response += `• **${project.name}**${marker}\n`;
        }

        if (activeFolder) {
          response += `\n📍 Currently active: **${activeFolder}**`;
        } else {
          response += `\n📍 No project currently active for this chat.`;
        }

        response += `\n\nUse switchCoderProject to change the active project before running coding tasks.`;

        this.agentLogger.info(LogEvent.TOOL_RESULT, `Listed ${projects.length} coder projects`, { chatId });
        return response;
      },
      {
        name: 'listCoderProjects',
        description: `List all available coder project folders. Use this when:
- The user asks "what projects do I have?" or "show my projects"
- You need to know which projects exist before switching
- The user wants to see the current active project
- Before running a coding task when you're unsure which project to use

This shows all folders under data/coder/ and indicates which one is currently active.`,
      },
    );
  }

  private createSwitchCoderProjectTool(chatId: string) {
    return tool(
      async (input: { projectName: string; createIfNotExists?: boolean }) => {
        this.agentLogger.info(LogEvent.TOOL_EXECUTING, `Switching to coder project: ${input.projectName}`, { chatId });

        const projectExists = await this.configService.coderProjectExists(input.projectName);

        if (!projectExists && !input.createIfNotExists) {
          // List available projects to help the user
          const projects = await this.configService.listCoderProjects();
          const projectNames = projects.map((p) => p.name).join(', ') || 'none';

          this.agentLogger.info(LogEvent.TOOL_RESULT, `Project not found: ${input.projectName}`, { chatId });
          return `❌ Project folder "${input.projectName}" does not exist.\n\nAvailable projects: ${projectNames}\n\nSet createIfNotExists=true to create a new project folder, or use an existing project name.`;
        }

        await this.configService.setCoderActiveFolder(chatId, input.projectName);

        this.agentLogger.info(LogEvent.TOOL_RESULT, `Switched to project: ${input.projectName}`, { chatId });

        if (!projectExists) {
          return `✅ Switched to new project: **${input.projectName}**\n\nThis is a new project folder that will be created when you run your first coding task.`;
        }

        return `✅ Switched to project: **${input.projectName}**\n\nAll subsequent coding tasks will run in this project folder.`;
      },
      {
        name: 'switchCoderProject',
        description: `Switch the active coder project folder. Use this when:
- The user explicitly asks to "switch to project X" or "work on project Y"
- The user mentions a different project than the currently active one
- Before running a coding task when the user's intent is for a different project
- The user wants to start a new project (set createIfNotExists=true)

IMPORTANT: If unsure which project the user wants, use listCoderProjects first to show available options, or ASK the user to clarify.`,
        schema: z.object({
          projectName: z.string().describe('The name of the project folder to switch to (e.g., "my-app", "test-api")'),
          createIfNotExists: z.boolean().optional().describe('If true, allows switching to a new project name that will be created on first use. Default: false'),
        }),
      },
    );
  }

  // ===== Memory Tools =====

  private createMemorySearchTool(chatId: string) {
    return tool(
      async (input: { query: string; maxResults?: number }) => {
        this.agentLogger.info(LogEvent.TOOL_EXECUTING, `Memory search: ${input.query}`, { chatId });

        try {
          const results = await this.memoryService.searchMemory(chatId, input.query, {
            maxResults: input.maxResults ?? 5,
            minScore: 0.3,
          });

          if (results.length === 0) {
            this.agentLogger.info(LogEvent.TOOL_RESULT, 'Memory search: no results', { chatId });
            return 'No relevant memories found for this query.';
          }

          let response = `Found ${results.length} relevant memories:\n\n`;
          for (let i = 0; i < results.length; i++) {
            const result = results[i];
            const source = result.source === 'long-term' ? '📌' : '💬';
            response += `${i + 1}. ${source} ${result.content}\n`;
            response += `   (Score: ${(result.score * 100).toFixed(0)}%, Source: ${result.source})\n\n`;
          }

          this.agentLogger.info(LogEvent.TOOL_RESULT, `Memory search: found ${results.length} results`, { chatId });
          return response;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.agentLogger.error(LogEvent.TOOL_ERROR, `Memory search failed: ${errorMsg}`, { chatId });
          return `Memory search failed: ${errorMsg}`;
        }
      },
      {
        name: 'memorySearch',
        description: `Search your memory for relevant past conversations, facts, preferences, or decisions. Use BEFORE answering questions about:
- Past work or conversations ("what did we discuss about X?")
- User preferences ("do I like X?", "how do I prefer X?")
- Previous decisions ("what did we decide about X?")
- User facts ("what's my name?", "where do I live?")
- Pending tasks or todos

This searches both recent conversation history and long-term memories.`,
        schema: z.object({
          query: z.string().describe('What to search for in memory (e.g. "user preferences for coffee", "decision about API design")'),
          maxResults: z.number().optional().describe('Maximum number of results to return (default: 5)'),
        }),
      },
    );
  }

  private createMemorySaveTool(chatId: string) {
    return tool(
      async (input: { content: string; category: string; tags?: string[] }) => {
        this.agentLogger.info(LogEvent.TOOL_EXECUTING, `Memory save: ${input.content.slice(0, 50)}...`, { chatId });

        try {
          // Validate category
          const validCategories: MemoryCategory[] = ['fact', 'preference', 'decision', 'context', 'todo'];
          const category = validCategories.includes(input.category as MemoryCategory)
            ? (input.category as MemoryCategory)
            : 'fact';

          const longTermService = this.memoryService.getLongTermMemoryService();
          const entry = await longTermService.addMemory(chatId, {
            content: input.content,
            category,
            source: 'manual',
            tags: input.tags,
          });

          this.agentLogger.info(LogEvent.TOOL_RESULT, `Memory saved: ${entry.id}`, { chatId });
          return `✅ Saved to long-term memory:\n"${input.content}"\n\nCategory: ${category}${input.tags ? `\nTags: ${input.tags.join(', ')}` : ''}`;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.agentLogger.error(LogEvent.TOOL_ERROR, `Memory save failed: ${errorMsg}`, { chatId });
          return `Failed to save memory: ${errorMsg}`;
        }
      },
      {
        name: 'memorySave',
        description: `Save an important fact, preference, or decision to long-term memory. Use when:
- The user explicitly asks you to remember something ("remember that I...", "don't forget...")
- Important personal information is shared (name, location, preferences)
- A significant decision is made
- The user shares ongoing context about projects or goals

DO NOT use for runtime/temporary data like "last BTC price" - use updateNotepad for tracking data over time.

Categories:
- "fact": Factual information about the user or their world
- "preference": User likes, dislikes, or preferences
- "decision": A decision that was made
- "context": Ongoing context (projects, situations)
- "todo": Something to remember to do`,
        schema: z.object({
          content: z.string().describe('What to remember (e.g. "User prefers dark mode", "User is working on project X")'),
          category: z.enum(['fact', 'preference', 'decision', 'context', 'todo']).describe('Category of the memory'),
          tags: z.array(z.string()).optional().describe('Optional tags for easier searching (e.g. ["programming", "preference"])'),
        }),
      },
    );
  }

  // ===== Generic Notepad Tools =====

  private createListNotepadsTool(chatId: string) {
    return tool(
      (input: { category?: string }) => {
        this.agentLogger.info(LogEvent.TOOL_EXECUTING, `List notepads${input.category ? ` (category: ${input.category})` : ''}`, { chatId });

        const notepads = this.notepadService.listNotepads(chatId, input.category);

        if (notepads.length === 0) {
          return input.category
            ? `No notepads found in category "${input.category}". Use updateNotepad to create one.`
            : 'No notepads found. Use updateNotepad to create one.';
        }

        let response = `📓 **Notepads** (${notepads.length}):\n\n`;
        for (const np of notepads) {
          const categoryTag = np.category ? ` [${np.category}]` : '';
          const name = np.name ? ` - ${np.name}` : '';
          response += `• **${np.id}**${categoryTag}${name}\n`;
          response += `  Keys: ${np.keyValueKeys.length > 0 ? np.keyValueKeys.join(', ') : 'none'}`;
          response += ` | Data entries: ${np.dataLogCount}`;
          response += ` | Has notes: ${np.hasNotes ? 'yes' : 'no'}\n`;
          response += `  Updated: ${new Date(np.lastUpdated).toLocaleString()}\n\n`;
        }

        this.agentLogger.info(LogEvent.TOOL_RESULT, `Listed ${notepads.length} notepads`, { chatId });
        return response;
      },
      {
        name: 'listNotepads',
        description: `List all notepads. Shows what notepads exist with a summary of their contents.
Notepads persist data across runs - use for tracking metrics, decisions, or any data over time.`,
        schema: z.object({
          category: z.string().optional().describe('Optional: filter by category (e.g., "schedule")'),
        }),
      },
    );
  }

  private createReadNotepadTool(chatId: string) {
    return tool(
      (input: { notepadId: string }) => {
        this.agentLogger.info(LogEvent.TOOL_EXECUTING, `Read notepad: ${input.notepadId}`, { chatId });

        const notepad = this.notepadService.loadNotepad(chatId, input.notepadId);

        if (!notepad) {
          return `Notepad "${input.notepadId}" not found. Use listNotepads to see available notepads, or updateNotepad to create one.`;
        }

        if (!notepad.notes && notepad.dataLog.length === 0 && Object.keys(notepad.keyValues).length === 0) {
          return `Notepad "${input.notepadId}" exists but is empty. Use updateNotepad to add notes, data entries, or key values.`;
        }

        let response = `📓 **Notepad: ${input.notepadId}**`;
        if (notepad.category) response += ` [${notepad.category}]`;
        if (notepad.name) response += ` - ${notepad.name}`;
        response += '\n\n';

        if (notepad.notes) {
          response += `**Notes:**\n${notepad.notes}\n\n`;
        }

        if (Object.keys(notepad.keyValues).length > 0) {
          response += `**Key Values:**\n${JSON.stringify(notepad.keyValues, null, 2)}\n\n`;
        }

        if (notepad.dataLog.length > 0) {
          response += `**Data Log** (${notepad.dataLog.length} entries):\n`;
          // Show recent entries (last 20)
          const recentEntries = notepad.dataLog.slice(-20);
          for (const entry of recentEntries) {
            const time = new Date(entry.timestamp).toLocaleString();
            response += `[${time}] ${JSON.stringify(entry.entry)}\n`;
          }
          if (notepad.dataLog.length > 20) {
            response += `... and ${notepad.dataLog.length - 20} more entries\n`;
          }
        }

        response += `\nCreated: ${new Date(notepad.createdAt).toLocaleString()}`;
        response += `\nLast updated: ${new Date(notepad.lastUpdated).toLocaleString()}`;

        this.agentLogger.info(LogEvent.TOOL_RESULT, `Read notepad ${input.notepadId}`, { chatId });
        return response;
      },
      {
        name: 'readNotepad',
        description: `Read a notepad's contents (notes, keyValues, dataLog). Use to review data from previous runs.`,
        schema: z.object({
          notepadId: z.string().describe('The notepad ID to read'),
        }),
      },
    );
  }

  private createUpdateNotepadTool(chatId: string) {
    return tool(
      (input: {
        notepadId: string;
        category?: string;
        name?: string;
        notes?: string;
        appendToNotes?: string;
        addDataEntry?: Record<string, any>;
        keyValues?: Record<string, any>;
      }) => {
        this.agentLogger.info(LogEvent.TOOL_EXECUTING, `Update notepad: ${input.notepadId}`, { chatId });

        // Validate that at least one update is provided
        if (!input.notes && !input.appendToNotes && !input.addDataEntry && !input.keyValues && !input.name) {
          return 'No updates provided. Provide at least one of: notes, appendToNotes, addDataEntry, keyValues, or name.';
        }

        // Check if notepad exists, if not create with category
        let notepad = this.notepadService.loadNotepad(chatId, input.notepadId);
        const isNew = !notepad;

        if (isNew) {
          notepad = this.notepadService.createNotepad(chatId, input.notepadId, {
            category: input.category,
            name: input.name,
          });
        }

        notepad = this.notepadService.updateNotepad(chatId, input.notepadId, {
          notes: input.notes,
          appendToNotes: input.appendToNotes,
          addDataEntry: input.addDataEntry,
          keyValues: input.keyValues,
          name: input.name,
        });

        let response = isNew
          ? `✅ Created and updated notepad "${input.notepadId}"\n\n`
          : `✅ Updated notepad "${input.notepadId}"\n\n`;

        if (input.name) {
          response += `• Name: ${input.name}\n`;
        }
        if (input.notes) {
          response += `• Notes replaced\n`;
        }
        if (input.appendToNotes) {
          response += `• Appended to notes\n`;
        }
        if (input.addDataEntry) {
          response += `• Added data entry: ${JSON.stringify(input.addDataEntry)}\n`;
          response += `  (Total entries: ${notepad.dataLog.length})\n`;
        }
        if (input.keyValues) {
          response += `• Updated key values: ${Object.keys(input.keyValues).join(', ')}\n`;
        }

        this.agentLogger.info(LogEvent.TOOL_RESULT, `Updated notepad ${input.notepadId}`, { chatId });
        return response;
      },
      {
        name: 'updateNotepad',
        description: `Update or create a notepad. Notepads persist data across runs.

**What to store:**
- keyValues: Quick reference data (e.g., lastPrice, threshold, currentStatus)
- addDataEntry: Time-series data points with auto-timestamp (e.g., {price: 185, change: "+2%"})
- notes/appendToNotes: Brief decisions, observations, reasoning

**For scheduled tasks:** The notepad is auto-created with the job ID. Just use the job ID as notepadId.

**Example:**
updateNotepad({
  notepadId: "job_123",
  addDataEntry: { price: 45000, change: "+2.3%" },
  keyValues: { lastPrice: 45000, trend: "bullish" }
})`,
        schema: z.object({
          notepadId: z.string().describe('Unique notepad ID (for scheduled tasks, use the job ID)'),
          category: z.string().optional().describe('Optional: category for organization'),
          name: z.string().optional().describe('Optional: human-readable name'),
          notes: z.string().optional().describe('Replace all notes'),
          appendToNotes: z.string().optional().describe('Add to existing notes'),
          addDataEntry: z.record(z.string(), z.any()).optional().describe('Add timestamped data entry'),
          keyValues: z.record(z.string(), z.any()).optional().describe('Update key-value pairs (merged with existing)'),
        }),
      },
    );
  }

  private createDeleteNotepadTool(chatId: string) {
    return tool(
      (input: { notepadId: string }) => {
        this.agentLogger.info(LogEvent.TOOL_EXECUTING, `Delete notepad: ${input.notepadId}`, { chatId });

        const deleted = this.notepadService.deleteNotepad(chatId, input.notepadId);

        if (deleted) {
          this.agentLogger.info(LogEvent.TOOL_RESULT, `Deleted notepad ${input.notepadId}`, { chatId });
          return `✅ Notepad "${input.notepadId}" has been deleted.`;
        }

        return `Notepad "${input.notepadId}" not found.`;
      },
      {
        name: 'deleteNotepad',
        description: 'Delete a notepad and all its data. Use with caution - this cannot be undone.',
        schema: z.object({
          notepadId: z.string().describe('The notepad ID to delete'),
        }),
      },
    );
  }
}
