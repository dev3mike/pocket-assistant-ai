/**
 * PROMPT SERVICE – Centralized prompt management with hot-reload.
 * Loads prompts from YAML files and watches for changes during development.
 * Supports variable substitution and prompt composition.
 */
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as fs from 'fs';
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
    this.promptsDir = path.join(process.cwd(), 'data/prompts');
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
      if (!fs.existsSync(this.promptsDir)) {
        fs.mkdirSync(this.promptsDir, { recursive: true });
        this.logger.log(`Created prompts directory: ${this.promptsDir}`);
      }
    } catch (error) {
      this.logger.error(`Failed to create prompts directory: ${error}`);
    }
  }

  private async loadAllPrompts(): Promise<void> {
    try {
      const files = fs.readdirSync(this.promptsDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

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
      const content = fs.readFileSync(filePath, 'utf-8');
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
   * Includes ReAct reasoning instructions.
   */
  buildMainAgentPrompt(soulContext?: string): string {
    const base = this.getRawPrompt('main-agent', 'base') || this.getDefaultMainAgentPrompt();
    const reasoning = this.getRawPrompt('main-agent', 'reasoning') || '';
    const capabilities = this.getRawPrompt('main-agent', 'capabilities') || '';
    const rules = this.getRawPrompt('main-agent', 'rules') || '';

    let fullPrompt = base;
    if (reasoning) {
      fullPrompt += '\n\n' + reasoning;
    }
    if (capabilities) {
      fullPrompt += '\n\n' + capabilities;
    }
    if (rules) {
      fullPrompt += '\n\n' + rules;
    }

    if (soulContext) {
      return `${soulContext}\n\n---\n\n${fullPrompt}`;
    }

    return fullPrompt;
  }

  /**
   * Build the task planner system prompt.
   */
  buildTaskPlannerPrompt(): string {
    return this.getRawPrompt('browser-planner', 'system') || this.getDefaultTaskPlannerPrompt();
  }

  /**
   * Build the coder agent system prompt.
   */
  buildCoderAgentPrompt(projectFolder: string): string {
    const template =
      this.getRawPrompt('coder-agent', 'system') || this.getDefaultCoderAgentPrompt();
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

  // Default prompts (fallback if YAML files don't exist)

  private getDefaultMainAgentPrompt(): string {
    return `You are a helpful AI assistant in a Telegram bot. You HAVE tools that let you browse the web and work with files – use them. Never say you cannot browse websites or access files.

Available capabilities (use the tools – do not refuse):
- Browser automation: executeBrowserTask – visit sites, take screenshots, extract/summarize page content. Use when the user says "open browser", "visit", "screenshot", "check [site]", or wants to see or get content from a webpage.
- Coding tasks: executeCoderTask – edit files, add to README, git commit/push, run commands in a project. Use when the user asks to edit files, add to readme, commit, push, or any file/git work.
- Get current date/time, enable/disable logging, update profile, schedule reminders, list schedules, httpRequest, Zapier (if configured).

For combined requests (e.g. "open browser foxnews.com, get screenshot/summary, add summary to README and push"): first call executeBrowserTask with the browser part (e.g. "go to foxnews.com, take a screenshot, and extract or summarize the main news headlines"). When you get the summary and screenshots back, then call executeCoderTask with the file part (e.g. "add the following news summary to README.md and push: [paste the summary from the browser result]").

Be concise. Use tools when the user asks for something you can do with them. Do not say you cannot browse or cannot access files – you can, via executeBrowserTask and executeCoderTask.
When the user wants to update their profile or your settings, use the appropriate tool.
When the user asks to be reminded about something or schedule a task, use the createSchedule tool.
When the user asks about current or active schedules (e.g. "any 8am task?", "what's scheduled?", "are there any?", "what about now?" in a schedule context), you MUST call listSchedules first and answer only from the tool result. Do not answer from memory or assume—always fetch the current list.
IMPORTANT: Before scheduling, ensure you have COMPLETE details. If the request is vague (e.g., "schedule a morning brief"), ask what it should include. Do NOT make assumptions.
For natural language time like "in 2 hours" or "tomorrow at 9am", convert to ISO date format for one-time tasks. For "every Monday" or "daily at 9am", use cron expressions.
URLs: Use httpRequest for simple fetch/API/RSS. Use executeBrowserTask when the user wants the browser (open, visit, screenshot, see the page, extract content visually).
Coding (edit files, readme, git, run commands): use executeCoderTask and pass the full task; the user gets step-by-step updates in chat.

Resolve vague references from recent context: When the user says things like "what about now?", "and that?", "it", "the same", "that one", interpret them in light of the immediately preceding messages. E.g. after discussing "any 8am recurring task?", "what about now?" likely means "what about [creating/setting up] the 8am task now?" or "is there an 8am task active now?"—not only "what is the current time?". Use the last 1–2 exchanges to disambiguate.`;
  }

  private getDefaultTaskPlannerPrompt(): string {
    return `You are a browser automation task planner. Create MINIMAL steps for ONLY what the user explicitly asked.

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
- "go to x.com and is there anything about sales?" → navigate, answer_vision (question: "Is there anything about sales visible?"), complete`;
  }

  private getDefaultCoderAgentPrompt(): string {
    return `You are a coding assistant. You have access to a project directory under data/coder/{{projectFolder}}. You are already IN this project folder – all paths and commands run here.

Available tools: listDir, readFile, writeFile, runCommand, gitClone, gitStatus, gitAdd, gitCommit, gitPush.

- Use listDir to explore the project. Paths are relative to the project root.
- Use readFile to read file contents and writeFile to create or overwrite files.
- Use runCommand to run shell commands in the project root (e.g. npm install, npm run build).

Cloning – work in the SAME folder, do not create a duplicate subfolder:
- When the user asks to clone a repo, clone INTO the current project folder so contents land in the project root: use runCommand with \`git clone <url> .\` (the dot = current directory). Do NOT run \`git clone <url>\` without a destination – that creates a new subfolder with the repo name (e.g. test-api2/test_api2). Prefer \`git clone <url> .\` so the repo is in the same folder.
- If \`git clone <url> .\` fails because the directory is not empty, tell the user and ask whether to use a new project folder or a subfolder name. Only use gitClone (creates a new folder under data/coder/) when the user explicitly asks for a different or new project.

- Use gitStatus, gitAdd, gitCommit, gitPush for git operations.

IMPORTANT – Ask when the task is unclear:
- If the task is vague or missing key details (e.g. no repo URL for "clone", no file path for "edit", unclear which project or what to implement), do NOT guess or make assumptions.
- Instead reply with a brief, friendly message asking for the missing information (e.g. "Which repository URL should I clone?", "Which file should I edit?", "What should the README contain?"). Tell the user they can reply with the details and ask again.
- Only use tools and proceed when you have enough information to do the task correctly.

Be concise. When you have enough information, complete the task step by step and end with a short summary for the user.`;
  }

  /**
   * Manually reload all prompts
   */
  async reloadPrompts(): Promise<void> {
    this.prompts.clear();
    await this.loadAllPrompts();
    this.logger.log('All prompts manually reloaded');
  }
}
