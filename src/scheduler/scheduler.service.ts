/**
 * ENTRY POINT for scheduled tasks. Stores and runs recurring or one-time jobs
 * (e.g. "remind me at 9am" or "every day check example.com"). When a job is due,
 * it calls the MAIN AGENT (AgentService.processMessage) with the job's task text,
 * then sends the agent's reply (and any screenshots) via TelegramService. The
 * main agent may in turn call executeBrowserTask, so scheduled browser checks
 * use the same flow as user-initiated browser tasks.
 */
import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject, forwardRef } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { IMessagingService, MESSAGING_SERVICE } from '../messaging/messaging.interface';
import { AgentService } from '../agent/agent.service';
import { NotepadService } from '../notepad/notepad.service';

export interface ScheduledJob {
  id: string;
  chatId: string;
  description: string;
  taskContext: string;
  scheduleType: 'once' | 'recurring';

  // For one-time tasks
  executeAt?: string; // ISO date string

  // For recurring tasks
  cronExpression?: string; // Cron expression (e.g., "0 9 * * MON")

  // Execution limits
  maxExecutions?: number; // null/undefined = unlimited, 1 = one-time
  executionCount: number;

  // Model settings
  useGeniusModel?: boolean; // Use high-capability model for complex reasoning

  // Metadata
  createdAt: string;
  lastExecutedAt?: string;
  status: 'active' | 'completed' | 'cancelled';
  cancelledAt?: string; // ISO date when cancelled (for memory cleanup)
}

interface CronJobsData {
  jobs: ScheduledJob[];
}

@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly dataDir: string;
  private jobs: ScheduledJob[] = [];
  private checkInterval: NodeJS.Timeout | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private executingJobIds: Set<string> = new Set(); // Guard against concurrent execution
  private readonly CHECK_INTERVAL_MS = 60000; // Check every minute
  private readonly CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // Cleanup daily
  private readonly CLEANUP_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  constructor(
    @Inject(MESSAGING_SERVICE)
    private readonly messagingService: IMessagingService,
    @Inject(forwardRef(() => AgentService))
    private readonly agentService: AgentService,
    private readonly notepadService: NotepadService,
  ) {
    this.dataDir = path.join(process.cwd(), 'data');
  }

  private getUserDir(chatId: string): string {
    return path.join(this.dataDir, chatId);
  }

  private getSchedulePath(chatId: string): string {
    return path.join(this.getUserDir(chatId), 'schedules.json');
  }

  async onModuleInit() {
    this.loadJobs();
    this.startJobChecker();
    this.startCleanupService();
    this.logger.log(`Scheduler initialized with ${this.jobs.filter((j) => j.status === 'active').length} active jobs`);
  }

  async onModuleDestroy() {
    this.stopJobChecker();
    this.stopCleanupService();
  }

  /**
   * Load jobs from all user directories
   */
  private loadJobs(): void {
    this.jobs = [];

    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
        return;
      }

      // Scan all subdirectories in data folder
      const entries = fs.readdirSync(this.dataDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const chatId = entry.name;
        const schedulePath = this.getSchedulePath(chatId);

        if (fs.existsSync(schedulePath)) {
          try {
            const data = fs.readFileSync(schedulePath, 'utf-8');
            const parsed: CronJobsData = JSON.parse(data);
            if (parsed.jobs && Array.isArray(parsed.jobs)) {
              this.jobs.push(...parsed.jobs);
            }
          } catch (error) {
            this.logger.error(`Failed to load jobs for chat ${chatId}: ${error}`);
          }
        }
      }

      this.logger.log(`Loaded ${this.jobs.length} scheduled jobs from storage`);
    } catch (error) {
      this.logger.error(`Failed to load jobs: ${error}`);
      this.jobs = [];
    }
  }

  /**
   * Save jobs to per-user files
   */
  private saveJobs(): void {
    // Group jobs by chatId
    const jobsByChat = new Map<string, ScheduledJob[]>();

    for (const job of this.jobs) {
      const existing = jobsByChat.get(job.chatId) || [];
      existing.push(job);
      jobsByChat.set(job.chatId, existing);
    }

    // Save each user's jobs to their directory
    for (const [chatId, jobs] of jobsByChat) {
      this.saveJobsForChat(chatId, jobs);
    }
  }

  /**
   * Save jobs for a specific chat
   */
  private saveJobsForChat(chatId: string, jobs: ScheduledJob[]): void {
    try {
      const userDir = this.getUserDir(chatId);
      if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true });
      }

      const schedulePath = this.getSchedulePath(chatId);
      const data: CronJobsData = { jobs };
      fs.writeFileSync(schedulePath, JSON.stringify(data, null, 2));
    } catch (error) {
      this.logger.error(`Failed to save jobs for chat ${chatId}: ${error}`);
    }
  }

  /**
   * Start the job checker interval
   */
  private startJobChecker(): void {
    // Check immediately on startup
    this.checkAndExecuteDueJobs();

    // Then check periodically
    this.checkInterval = setInterval(() => {
      this.checkAndExecuteDueJobs();
    }, this.CHECK_INTERVAL_MS);

    this.logger.log('Job checker started');
  }

  /**
   * Stop the job checker interval
   */
  private stopJobChecker(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      this.logger.log('Job checker stopped');
    }
  }

  /**
   * Start the cleanup service that removes old cancelled/completed jobs
   */
  private startCleanupService(): void {
    // Run cleanup immediately on startup
    this.cleanupOldJobs();

    // Then run cleanup daily
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldJobs();
    }, this.CLEANUP_INTERVAL_MS);

    this.logger.log('Cleanup service started (runs daily)');
  }

  /**
   * Stop the cleanup service
   */
  private stopCleanupService(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      this.logger.log('Cleanup service stopped');
    }
  }

  /**
   * Remove cancelled and completed jobs older than 7 days
   * Also cleans up associated schedule memory files
   */
  private cleanupOldJobs(): void {
    const now = Date.now();
    const initialCount = this.jobs.length;
    const jobsToRemove: ScheduledJob[] = [];

    this.jobs = this.jobs.filter((job) => {
      // Keep active jobs
      if (job.status === 'active') {
        return true;
      }

      // For cancelled jobs, use cancelledAt if available
      // For completed jobs, use lastExecutedAt or createdAt
      let jobDate: number;
      if (job.status === 'cancelled' && job.cancelledAt) {
        jobDate = new Date(job.cancelledAt).getTime();
      } else if (job.lastExecutedAt) {
        jobDate = new Date(job.lastExecutedAt).getTime();
      } else {
        jobDate = new Date(job.createdAt).getTime();
      }

      const age = now - jobDate;

      // If older than cleanup age, mark for removal
      if (age >= this.CLEANUP_AGE_MS) {
        jobsToRemove.push(job);
        return false;
      }

      return true;
    });

    // Clean up schedule notepad files for removed jobs
    for (const job of jobsToRemove) {
      this.notepadService.deleteNotepad(job.chatId, job.id);
    }

    const removedCount = initialCount - this.jobs.length;

    if (removedCount > 0) {
      this.saveJobs();
      this.logger.log(`Cleanup: Removed ${removedCount} old cancelled/completed jobs and their memory files`);
    }
  }

  /**
   * Check for due jobs and execute them
   */
  private async checkAndExecuteDueJobs(): Promise<void> {
    const now = new Date();
    const activeJobs = this.jobs.filter((j) => j.status === 'active');

    for (const job of activeJobs) {
      // Skip if already executing (prevents race conditions for long-running jobs)
      if (this.executingJobIds.has(job.id)) {
        continue;
      }

      const isDue = this.isJobDue(job, now);

      if (isDue) {
        await this.executeJob(job);
      }
    }
  }

  /**
   * Check if a job is due for execution
   */
  private isJobDue(job: ScheduledJob, now: Date): boolean {
    if (job.scheduleType === 'once' && job.executeAt) {
      const executeTime = new Date(job.executeAt);
      // Check if the execution time has passed and job hasn't been executed yet
      return now >= executeTime && job.executionCount === 0;
    }

    if (job.scheduleType === 'recurring' && job.cronExpression) {
      return this.matchesCronExpression(job.cronExpression, now, job.lastExecutedAt);
    }

    return false;
  }

  /**
   * Simple cron expression matcher
   * Supports: minute hour dayOfMonth month dayOfWeek
   * Example: "30 9 * * 1" = 9:30 AM every Monday
   */
  private matchesCronExpression(expression: string, now: Date, lastExecutedAt?: string): boolean {
    // Avoid executing multiple times in the same minute
    if (lastExecutedAt) {
      const lastExec = new Date(lastExecutedAt);
      if (
        lastExec.getFullYear() === now.getFullYear() &&
        lastExec.getMonth() === now.getMonth() &&
        lastExec.getDate() === now.getDate() &&
        lastExec.getHours() === now.getHours() &&
        lastExec.getMinutes() === now.getMinutes()
      ) {
        return false;
      }
    }

    const parts = expression.trim().split(/\s+/);
    if (parts.length !== 5) {
      this.logger.warn(`Invalid cron expression: ${expression}`);
      return false;
    }

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    const matches =
      this.matchCronField(minute, now.getMinutes()) &&
      this.matchCronField(hour, now.getHours()) &&
      this.matchCronField(dayOfMonth, now.getDate()) &&
      this.matchCronField(month, now.getMonth() + 1) && // Month is 1-12 in cron
      this.matchCronField(dayOfWeek, now.getDay()); // 0 = Sunday

    return matches;
  }

  /**
   * Match a single cron field
   */
  private matchCronField(field: string, value: number): boolean {
    // Wildcard
    if (field === '*') {
      return true;
    }

    // Exact match
    if (/^\d+$/.test(field)) {
      return parseInt(field, 10) === value;
    }

    // Range (e.g., 1-5)
    if (field.includes('-')) {
      const [start, end] = field.split('-').map((n) => parseInt(n, 10));
      return value >= start && value <= end;
    }

    // List (e.g., 1,3,5)
    if (field.includes(',')) {
      const values = field.split(',').map((n) => parseInt(n, 10));
      return values.includes(value);
    }

    // Step (e.g., */5)
    if (field.startsWith('*/')) {
      const step = parseInt(field.slice(2), 10);
      return value % step === 0;
    }

    return false;
  }

  /**
   * Execute a job and update its state
   */
  private async executeJob(job: ScheduledJob): Promise<void> {
    // Guard against concurrent execution
    if (this.executingJobIds.has(job.id)) {
      this.logger.warn(`Job ${job.id} is already executing, skipping duplicate trigger`);
      return;
    }

    this.executingJobIds.add(job.id);
    this.logger.log(`Executing job ${job.id}: ${job.description}`);

    try {
      const taskPrompt = this.buildTaskPrompt(job);

      // Use the full agent to process the task (with all tools available)
      // The agent can use readScheduleNotepad/updateScheduleNotepad to manage its own memory
      const { text, screenshots } = await this.agentService.processMessage(
        job.chatId,
        taskPrompt,
        undefined, // onProgress - no progress callback for scheduled tasks
        undefined, // attachedFiles
        job.useGeniusModel ? 'genius' : undefined,
      );

      const result = await this.messagingService.sendMessage(job.chatId, text);

      if (screenshots.length > 0) {
        await this.messagingService.sendPhotos(job.chatId, screenshots, '📸 Screenshot');
      }

      if (result.success) {
        job.executionCount++;
        job.lastExecutedAt = new Date().toISOString();
        if (job.scheduleType === 'once') {
          job.status = 'completed';
        } else if (job.maxExecutions && job.executionCount >= job.maxExecutions) {
          job.status = 'completed';
        }
        this.saveJobs();
        this.logger.log(`Job ${job.id} executed successfully (count: ${job.executionCount})`);
      } else {
        this.logger.error(`Failed to send message for job ${job.id}: ${result.error}`);
      }
    } catch (error) {
      this.logger.error(`Error executing job ${job.id}: ${error}`);
      await this.messagingService.sendMessage(job.chatId, `⏰ *Reminder*: ${job.description}`);
    } finally {
      this.executingJobIds.delete(job.id);
    }
  }

  /**
   * Build the task prompt for the agent
   * Includes notepad context for tracking data across runs
   */
  private buildTaskPrompt(job: ScheduledJob): string {
    // Get or create notepad for this schedule
    const notepad = this.notepadService.getOrCreateNotepad(job.chatId, job.id, {
      category: 'schedule',
      name: job.description,
    });

    let prompt = `[SCHEDULED TASK: ${job.id}]
Description: ${job.description}
Run #${job.executionCount + 1}${job.maxExecutions ? ` of ${job.maxExecutions}` : ''}
${job.useGeniusModel ? '🧠 Enhanced reasoning mode enabled\n' : ''}
---

`;

    // Include notepad context if it has content
    if (notepad.notes || notepad.dataLog.length > 0 || Object.keys(notepad.keyValues).length > 0) {
      prompt += `[NOTEPAD - Your persistent memory for this schedule]

`;
      if (Object.keys(notepad.keyValues).length > 0) {
        prompt += `🔑 Key Values: ${JSON.stringify(notepad.keyValues)}\n\n`;
      }

      if (notepad.dataLog.length > 0) {
        const recentEntries = notepad.dataLog.slice(-10);
        prompt += `📊 Data Log (${notepad.dataLog.length} entries, last ${recentEntries.length}):\n`;
        for (const entry of recentEntries) {
          const time = new Date(entry.timestamp).toLocaleString();
          prompt += `  [${time}] ${JSON.stringify(entry.entry)}\n`;
        }
        prompt += '\n';
      }

      if (notepad.notes) {
        prompt += `📝 Notes:\n${notepad.notes}\n\n`;
      }

      prompt += '---\n\n';
    }

    prompt += `[TASK]
${job.taskContext}

[NOTEPAD GUIDELINES]
Use updateNotepad with notepadId="${job.id}" ONLY for data that matters across runs:
✅ DO save: Key metrics (prices, counts), decisions made, thresholds, trends
✅ DO use keyValues for: Current state, thresholds, last values for comparison
✅ DO use addDataEntry for: Time-series data points (prices, metrics)
✅ DO use notes for: Brief decision reasoning, pattern observations

❌ DON'T save: Full responses, raw API data, redundant info, verbose explanations
❌ DON'T: Add notes every run unless something meaningful changed

**For EDUCATIONAL/LEARNING tasks (language lessons, daily facts, quizzes):**
1. FIRST read keyValues to see what was already taught (topicsCovered array)
2. Track curriculum progress in keyValues:
   - lessonsCompleted: number (increment each run)
   - topicsCovered: string[] (topics/phrases already taught)
   - lastTopic: string (for continuity)
3. Log each lesson in addDataEntry: { topic, content, phrases }
4. NEVER repeat content from topicsCovered - always teach something NEW
5. Reference previous lessons to build continuity

Keep it CONCISE. The notepad should be scannable, not a log of everything.

[RESPONSE REQUIREMENT]
⚠️ ALWAYS respond with a brief message after completing the task. Never end with just a tool call.
Even if only updating the notepad, provide a short summary (1-2 sentences) of what was done or observed.`;

    return prompt;
  }

  /**
   * Generate a unique job ID
   */
  private generateJobId(): string {
    return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // ===== Public API =====

  /**
   * Check if a similar schedule already exists
   * Returns the existing job if found, null otherwise
   */
  findSimilarJob(params: {
    chatId: string;
    cronExpression?: string;
    executeAt?: string;
  }): ScheduledJob | null {
    const activeJobs = this.jobs.filter(
      (j) => j.chatId === params.chatId && j.status === 'active',
    );

    for (const job of activeJobs) {
      // For recurring jobs, check if same cron expression
      if (params.cronExpression && job.cronExpression === params.cronExpression) {
        return job;
      }

      // For one-time jobs, check if same execution time (within 5 minutes)
      if (params.executeAt && job.executeAt) {
        const newTime = new Date(params.executeAt).getTime();
        const existingTime = new Date(job.executeAt).getTime();
        const timeDiff = Math.abs(newTime - existingTime);
        // Consider jobs within 5 minutes as duplicates
        if (timeDiff < 5 * 60 * 1000) {
          return job;
        }
      }
    }

    return null;
  }

  /**
   * Create a new scheduled job
   */
  createJob(params: {
    chatId: string;
    description: string;
    taskContext: string;
    executeAt?: string;
    cronExpression?: string;
    maxExecutions?: number;
    useGeniusModel?: boolean;
  }): ScheduledJob | { duplicate: true; existingJob: ScheduledJob } {
    // Check for duplicate schedules
    const existingJob = this.findSimilarJob({
      chatId: params.chatId,
      cronExpression: params.cronExpression,
      executeAt: params.executeAt,
    });

    if (existingJob) {
      this.logger.warn(
        `Duplicate schedule detected for chat ${params.chatId}. Existing job: ${existingJob.id}`,
      );
      return { duplicate: true, existingJob };
    }

    const scheduleType = params.cronExpression ? 'recurring' : 'once';

    const job: ScheduledJob = {
      id: this.generateJobId(),
      chatId: params.chatId,
      description: params.description,
      taskContext: params.taskContext,
      scheduleType,
      executeAt: params.executeAt,
      cronExpression: params.cronExpression,
      maxExecutions: params.maxExecutions,
      useGeniusModel: params.useGeniusModel,
      executionCount: 0,
      createdAt: new Date().toISOString(),
      status: 'active',
    };

    this.jobs.push(job);
    this.saveJobs();

    this.logger.log(`Created job ${job.id} for chat ${params.chatId}: ${params.description}`);

    return job;
  }

  /**
   * Get all jobs for a specific chat
   */
  getJobsForChat(chatId: string): ScheduledJob[] {
    return this.jobs.filter((j) => j.chatId === chatId);
  }

  /**
   * Get active jobs for a specific chat
   */
  getActiveJobsForChat(chatId: string): ScheduledJob[] {
    return this.jobs.filter((j) => j.chatId === chatId && j.status === 'active');
  }

  /**
   * Get inactive (cancelled/completed) jobs for a specific chat
   */
  getInactiveJobsForChat(chatId: string): ScheduledJob[] {
    return this.jobs.filter(
      (j) => j.chatId === chatId && (j.status === 'cancelled' || j.status === 'completed'),
    );
  }

  /**
   * Reactivate a cancelled or completed job
   */
  reactivateJob(jobId: string, chatId: string, newExecuteAt?: string): boolean {
    const job = this.jobs.find((j) => j.id === jobId && j.chatId === chatId);

    if (!job) {
      return false;
    }

    if (job.status === 'active') {
      return false; // Already active
    }

    // For one-time jobs, require a new execution time if the old one has passed
    if (job.scheduleType === 'once') {
      if (newExecuteAt) {
        const newTime = new Date(newExecuteAt);
        if (isNaN(newTime.getTime()) || newTime <= new Date()) {
          return false; // Invalid or past time
        }
        job.executeAt = newExecuteAt;
      } else if (job.executeAt) {
        const oldTime = new Date(job.executeAt);
        if (oldTime <= new Date()) {
          return false; // Old time has passed and no new time provided
        }
      }
      // Reset execution count for one-time jobs
      job.executionCount = 0;
    }

    job.status = 'active';
    this.saveJobs();

    this.logger.log(`Reactivated job ${jobId}`);
    return true;
  }

  /**
   * Cancel a job
   * Sets cancelledAt timestamp for memory cleanup after one week
   */
  cancelJob(jobId: string, chatId: string): boolean {
    const job = this.jobs.find((j) => j.id === jobId && j.chatId === chatId);

    if (!job) {
      return false;
    }

    job.status = 'cancelled';
    job.cancelledAt = new Date().toISOString();
    this.saveJobs();

    this.logger.log(`Cancelled job ${jobId} (memory will be cleaned up after one week)`);
    return true;
  }

  /**
   * Update an existing job's properties
   */
  updateJob(
    jobId: string,
    chatId: string,
    updates: {
      description?: string;
      taskContext?: string;
      executeAt?: string;
      cronExpression?: string;
      maxExecutions?: number;
      useGeniusModel?: boolean;
    },
  ): ScheduledJob | null {
    const job = this.jobs.find((j) => j.id === jobId && j.chatId === chatId);

    if (!job) {
      return null;
    }

    // Only allow updating active jobs
    if (job.status !== 'active') {
      return null;
    }

    // Apply updates
    if (updates.description !== undefined) {
      job.description = updates.description;
    }

    if (updates.taskContext !== undefined) {
      job.taskContext = updates.taskContext;
    }

    if (updates.executeAt !== undefined) {
      // Validate the new time
      const executeDate = new Date(updates.executeAt);
      if (isNaN(executeDate.getTime())) {
        return null;
      }
      if (executeDate <= new Date()) {
        return null;
      }
      job.executeAt = updates.executeAt;
      // If changing from cron to one-time
      if (job.cronExpression) {
        job.cronExpression = undefined;
        job.scheduleType = 'once';
      }
    }

    if (updates.cronExpression !== undefined) {
      // Validate cron expression
      const parts = updates.cronExpression.trim().split(/\s+/);
      if (parts.length !== 5) {
        return null;
      }
      job.cronExpression = updates.cronExpression;
      // If changing from one-time to recurring
      if (job.executeAt) {
        job.executeAt = undefined;
        job.scheduleType = 'recurring';
      }
    }

    if (updates.maxExecutions !== undefined) {
      job.maxExecutions = updates.maxExecutions;
    }

    if (updates.useGeniusModel !== undefined) {
      job.useGeniusModel = updates.useGeniusModel;
    }

    this.saveJobs();
    this.logger.log(`Updated job ${jobId}`);

    return job;
  }

  /**
   * Get a specific job by ID
   */
  getJob(jobId: string): ScheduledJob | undefined {
    return this.jobs.find((j) => j.id === jobId);
  }

  /**
   * Format job for display
   */
  formatJobForDisplay(job: ScheduledJob): string {
    let schedule = '';
    if (job.scheduleType === 'once' && job.executeAt) {
      schedule = `Once at: ${new Date(job.executeAt).toLocaleString()}`;
    } else if (job.cronExpression) {
      schedule = `Recurring: ${this.formatCronHumanReadable(job.cronExpression)}`;
      if (job.maxExecutions) {
        schedule += ` (${job.executionCount}/${job.maxExecutions} executions)`;
      }
    }

    const geniusMode = job.useGeniusModel ? '🧠 Genius Mode' : '';

    return `*${job.description}*${geniusMode ? ` ${geniusMode}` : ''}\nID: \`${job.id}\`\nSchedule: ${schedule}\nStatus: ${job.status}\n\n${job.taskContext}\n-------------------`;
  }

  /**
   * Convert cron expression to human-readable format
   */
  private formatCronHumanReadable(cron: string): string {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return cron;

    const [minute, hour, , , dayOfWeek] = parts;

    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    let dayStr = 'every day';

    if (dayOfWeek !== '*') {
      if (dayOfWeek.includes(',')) {
        const dayNums = dayOfWeek.split(',').map((d) => parseInt(d, 10));
        dayStr = dayNums.map((d) => days[d]).join(', ');
      } else if (dayOfWeek.includes('-')) {
        const [start, end] = dayOfWeek.split('-').map((d) => parseInt(d, 10));
        dayStr = `${days[start]} to ${days[end]}`;
      } else {
        dayStr = days[parseInt(dayOfWeek, 10)] || dayOfWeek;
      }
    }

    let timeStr = '';
    if (hour !== '*' && minute !== '*') {
      const h = parseInt(hour, 10);
      const m = parseInt(minute, 10);
      const ampm = h >= 12 ? 'PM' : 'AM';
      const h12 = h % 12 || 12;
      timeStr = `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
    } else {
      timeStr = `${hour}:${minute}`;
    }

    return `${dayStr} at ${timeStr}`;
  }
}
