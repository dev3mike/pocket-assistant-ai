/**
 * PROMPT SERVICE – Centralized prompt management with hot-reload.
 * Loads prompts from YAML files and watches for changes during development.
 * Supports variable substitution and prompt composition.
 */
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface PromptTemplate {
  [key: string]: string | PromptTemplate;
}

@Injectable()
export class PromptService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PromptService.name);
  private prompts: Map<string, PromptTemplate> = new Map();
  private readonly promptsDir: string;
  private fileWatchers: fs.FSWatcher[] = [];
  private reloadDebounceTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.promptsDir = path.join(process.cwd(), 'prompts');
  }

  async onModuleInit() {
    await this.ensurePromptsDirectory();
    await this.loadAllPrompts();
    this.startFileWatcher();
  }

  async onModuleDestroy() {
    this.stopFileWatcher();
  }

  private async ensurePromptsDirectory(): Promise<void> {
    try {
      const exists = await fsPromises.access(this.promptsDir).then(() => true).catch(() => false);
      if (!exists) {
        await fsPromises.mkdir(this.promptsDir, { recursive: true });
        this.logger.log(`Created prompts directory: ${this.promptsDir}`);
      }
    } catch (error) {
      this.logger.error(`Failed to create prompts directory: ${error}`);
    }
  }

  private async loadAllPrompts(): Promise<void> {
    try {
      const allFiles = await fsPromises.readdir(this.promptsDir);
      const files = allFiles.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

      for (const file of files) {
        await this.loadPromptFile(file);
      }

      this.logger.log(`Loaded ${this.prompts.size} prompt files`);
    } catch (error) {
      this.logger.warn(`Could not load prompts: ${error}`);
    }
  }

  private async loadPromptFile(filename: string): Promise<void> {
    try {
      const filePath = path.join(this.promptsDir, filename);
      const content = await fsPromises.readFile(filePath, 'utf-8');
      const parsed = yaml.load(content) as PromptTemplate;
      const name = filename.replace(/\.ya?ml$/, '');
      this.prompts.set(name, parsed);
      this.logger.debug(`Loaded prompt file: ${name}`);
    } catch (error) {
      this.logger.error(`Failed to load prompt file ${filename}: ${error}`);
    }
  }

  private startFileWatcher(): void {
    try {
      const watcher = fs.watch(this.promptsDir, (eventType, filename) => {
        if (filename && (filename.endsWith('.yaml') || filename.endsWith('.yml'))) {
          if (this.reloadDebounceTimer) {
            clearTimeout(this.reloadDebounceTimer);
          }

          this.reloadDebounceTimer = setTimeout(() => {
            this.logger.log(`Prompt file changed: ${filename}, reloading...`);
            this.loadPromptFile(filename);
          }, 100);
        }
      });

      this.fileWatchers.push(watcher);
      this.logger.log('Prompt file watcher started - changes will be auto-reloaded');
    } catch (error) {
      this.logger.warn(`Could not start prompt file watcher: ${error}`);
    }
  }

  private stopFileWatcher(): void {
    for (const watcher of this.fileWatchers) {
      watcher.close();
    }
    this.fileWatchers = [];
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
      this.reloadDebounceTimer = null;
    }
  }

  /**
   * Get a raw prompt template by file name and optional path.
   * Path uses dot notation: getPrompt('main-agent', 'capabilities.browser')
   */
  getRawPrompt(file: string, path?: string): string | undefined {
    const template = this.prompts.get(file);
    if (!template) {
      this.logger.warn(`Prompt file not found: ${file}`);
      return undefined;
    }

    if (!path) {
      // Return entire file as string if no path
      return typeof template === 'string' ? template : JSON.stringify(template);
    }

    // Navigate the path
    const parts = path.split('.');
    let current: PromptTemplate | string = template;

    for (const part of parts) {
      if (typeof current === 'string') {
        return undefined;
      }
      current = current[part] as PromptTemplate | string;
      if (current === undefined) {
        this.logger.warn(`Prompt path not found: ${file}.${path}`);
        return undefined;
      }
    }

    return typeof current === 'string' ? current : JSON.stringify(current);
  }

  /**
   * Get a prompt with variable substitution.
   * Variables in the prompt use {{variableName}} syntax.
   */
  getPrompt(file: string, path?: string, variables?: Record<string, string>): string {
    let prompt = this.getRawPrompt(file, path) || '';

    if (variables) {
      for (const [key, value] of Object.entries(variables)) {
        prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
      }
    }

    return prompt;
  }

  /**
   * Build the main agent system prompt with soul context.
   * Reads from main-agent.yaml - throws error if file is missing.
   */
  buildMainAgentPrompt(soulContext?: string): string {
    const base = this.getRawPrompt('main-agent', 'base');
    if (!base) {
      throw new Error('Missing required prompt file: prompts/main-agent.yaml (base section)');
    }

    const capabilities = this.getRawPrompt('main-agent', 'capabilities') || '';
    const rules = this.getRawPrompt('main-agent', 'rules') || '';
    const responseFormat = this.getRawPrompt('main-agent', 'response_format') || '';
    const dataStorage = this.getRawPrompt('main-agent', 'data_storage') || '';

    let fullPrompt = base;
    if (capabilities) {
      fullPrompt += '\n\n' + capabilities;
    }
    if (rules) {
      fullPrompt += '\n\n' + rules;
    }
    if (responseFormat) {
      fullPrompt += '\n\n' + responseFormat;
    }
    if (dataStorage) {
      fullPrompt += '\n\n' + dataStorage;
    }

    if (soulContext) {
      return `${soulContext}\n\n---\n\n${fullPrompt}`;
    }

    return fullPrompt;
  }

  /**
   * Build the task planner system prompt.
   * Reads from browser-planner.yaml - throws error if file is missing.
   */
  buildTaskPlannerPrompt(): string {
    const prompt = this.getRawPrompt('browser-planner', 'system');
    if (!prompt) {
      throw new Error('Missing required prompt file: prompts/browser-planner.yaml (system section)');
    }
    return prompt;
  }

  /**
   * Build the coder agent system prompt.
   * Reads from coder-agent.yaml - throws error if file is missing.
   */
  buildCoderAgentPrompt(projectFolder: string): string {
    const template = this.getRawPrompt('coder-agent', 'system');
    if (!template) {
      throw new Error('Missing required prompt file: prompts/coder-agent.yaml (system section)');
    }
    return template.replace(/\{\{projectFolder\}\}/g, projectFolder);
  }

  /**
   * Get AI service prompts for various operations.
   */
  getAiServicePrompt(operation: string): { system: string; user?: string } {
    const system = this.getRawPrompt('ai-service', `${operation}.system`) || '';
    const user = this.getRawPrompt('ai-service', `${operation}.user`);
    return { system, user };
  }

  /**
   * Manually reload all prompts
   */
  async reloadPrompts(): Promise<void> {
    this.prompts.clear();
    await this.loadAllPrompts();
    this.logger.log('All prompts manually reloaded');
  }

  /**
   * Build the scheduler task prompt.
   * Reads from scheduler.yaml - throws error if file is missing.
   */
  buildSchedulerTaskPrompt(params: {
    jobId: string;
    description: string;
    runNumber: number;
    maxExecutions?: number;
    useGeniusModel?: boolean;
    taskContext: string;
    notepadContext?: {
      keyValues?: Record<string, any>;
      dataLog?: Array<{ timestamp: string; entry: any }>;
      notes?: string;
    };
  }): string {
    // Build header
    const header = this.getPrompt('scheduler', 'task_header', {
      jobId: params.jobId,
      description: params.description,
      runNumber: String(params.runNumber),
      maxExecutions: params.maxExecutions ? ` of ${params.maxExecutions}` : '',
      geniusMode: params.useGeniusModel ? '🧠 Enhanced reasoning mode enabled\n' : '',
    });

    if (!header) {
      throw new Error('Missing required prompt file: prompts/scheduler.yaml (task_header section)');
    }

    let prompt = header + '\n\n';

    // Add notepad context if present
    if (params.notepadContext) {
      const { keyValues, dataLog, notes } = params.notepadContext;
      const hasContent = notes || (dataLog && dataLog.length > 0) || (keyValues && Object.keys(keyValues).length > 0);

      if (hasContent) {
        const contextHeader = this.getRawPrompt('scheduler', 'notepad_context_header') || '';
        prompt += contextHeader + '\n';

        if (keyValues && Object.keys(keyValues).length > 0) {
          prompt += `🔑 Key Values: ${JSON.stringify(keyValues)}\n\n`;
        }

        if (dataLog && dataLog.length > 0) {
          const recentEntries = dataLog.slice(-10);
          prompt += `📊 Data Log (${dataLog.length} entries, last ${recentEntries.length}):\n`;
          for (const entry of recentEntries) {
            const time = new Date(entry.timestamp).toLocaleString();
            prompt += `  [${time}] ${JSON.stringify(entry.entry)}\n`;
          }
          prompt += '\n';
        }

        if (notes) {
          prompt += `📝 Notes:\n${notes}\n\n`;
        }

        prompt += '---\n\n';
      }
    }

    // Add task context
    prompt += `[TASK]\n${params.taskContext}\n\n`;

    // Add notepad guidelines
    const guidelines = this.getPrompt('scheduler', 'notepad_guidelines', {
      jobId: params.jobId,
    });
    prompt += guidelines + '\n';

    // Add educational guidelines
    const educationalGuidelines = this.getRawPrompt('scheduler', 'educational_guidelines') || '';
    prompt += educationalGuidelines + '\n';

    // Add response requirement
    const responseRequirement = this.getRawPrompt('scheduler', 'response_requirement') || '';
    prompt += responseRequirement;

    return prompt;
  }
}
