import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { tool } from '@langchain/core/tools';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage } from '@langchain/core/messages';
import * as z from 'zod';
import * as path from 'path';
import * as fs from 'fs';
import { ConfigService } from 'src/config/config.service';

export interface AccessibilityNode {
  role: string;
  name: string;
  ref: string;
  value?: string;
  description?: string;
  children?: AccessibilityNode[];
  level?: number;
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  focused?: boolean;
  selected?: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  accessibilityTree: AccessibilityNode[];
  timestamp: number;
}

@Injectable()
export class BrowserToolsService implements OnModuleDestroy {
  private readonly logger = new Logger(BrowserToolsService.name);
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private refCounter = 0;
  private refMap: Map<string, any> = new Map();
  private screenshotDir: string;

  // Primary profile (shared with npm run browser for manual logins)
  private readonly userDataDir: string;
  // Fallback profile for bot when primary is locked
  private readonly botUserDataDir: string;

  constructor(private readonly configService: ConfigService) {
    this.screenshotDir = path.join(process.cwd(), 'data', 'screenshots');
    this.userDataDir = path.join(process.cwd(), 'data', 'browser-profile');
    this.botUserDataDir = path.join(process.cwd(), 'data', 'browser-profile-bot');

    if (!fs.existsSync(this.screenshotDir)) {
      fs.mkdirSync(this.screenshotDir, { recursive: true });
    }
    if (!fs.existsSync(this.userDataDir)) {
      fs.mkdirSync(this.userDataDir, { recursive: true });
    }
    if (!fs.existsSync(this.botUserDataDir)) {
      fs.mkdirSync(this.botUserDataDir, { recursive: true });
    }
  }

  async onModuleDestroy() {
    await this.closeBrowser();
  }

  /**
   * Stealth args to avoid detection
   */
  private readonly stealthArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
    '--window-size=1280,720',
    '--start-maximized',
    '--hide-scrollbars',
    '--mute-audio',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-infobars',
    '--disable-breakpad',
    '--disable-component-extensions-with-background-pages',
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-hang-monitor',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-sync',
    '--disable-translate',
    '--metrics-recording-only',
    '--no-first-run',
    '--safebrowsing-disable-auto-update',
  ];

  /**
   * Initialize browser if not already running
   * Uses persistent context to maintain login sessions
   * Falls back to temporary session if profile is locked
   * Configured to be undetectable by anti-bot systems
   */
  private async ensureBrowser(): Promise<Page> {
    if (!this.context) {
      // Try primary profile first, fall back to bot profile if locked
      try {
        this.context = await this.launchPersistentBrowser(this.userDataDir);
        this.logger.log('Stealth browser launched with primary profile');
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (errorMsg.includes('ProcessSingleton') || errorMsg.includes('already in use')) {
          this.logger.warn('Primary profile locked, using bot profile instead');
          this.context = await this.launchPersistentBrowser(this.botUserDataDir);
          this.logger.log('Stealth browser launched with bot profile');
        } else {
          throw error;
        }
      }

      // Get existing page or create new one
      const pages = this.context.pages();
      this.page = pages.length > 0 ? pages[0] : await this.context.newPage();

      // Apply stealth scripts to hide automation
      await this.applyStealthScripts(this.page);
    }

    if (!this.page || this.page.isClosed()) {
      this.page = await this.context!.newPage();
      await this.applyStealthScripts(this.page);
    }

    return this.page;
  }

  /**
   * Launch browser with persistent profile (preserves login sessions)
   */
  private async launchPersistentBrowser(profileDir: string): Promise<BrowserContext> {
    return chromium.launchPersistentContext(profileDir, {
      headless: false,
      args: this.stealthArgs,
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York',
      permissions: ['geolocation', 'notifications'],
      ignoreHTTPSErrors: true,
      bypassCSP: true,
    });
  }

  /**
   * Apply stealth scripts to make browser undetectable
   */
  private async applyStealthScripts(page: Page): Promise<void> {
    // Override navigator.webdriver
    await page.addInitScript(() => {
      // Remove webdriver property
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });

      // Override plugins to look like real browser
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ],
      });

      // Override languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });

      // Override permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters: any) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
          : originalQuery(parameters);

      // Override chrome runtime
      (window as any).chrome = {
        runtime: {},
        loadTimes: function () { },
        csi: function () { },
        app: {},
      };

      // Override WebGL vendor/renderer
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function (parameter) {
        if (parameter === 37445) return 'Intel Inc.';
        if (parameter === 37446) return 'Intel Iris OpenGL Engine';
        return getParameter.call(this, parameter);
      };
    });
  }

  /**
   * Close browser and cleanup
   */
  async closeBrowser(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.browser = null;
      this.context = null;
      this.page = null;
      this.refMap.clear();
      this.refCounter = 0;
      this.logger.log('Browser closed');
    }
  }

  /**
   * Generate unique ref for an element
   */
  private generateRef(): string {
    return `e${++this.refCounter}`;
  }

  /**
   * Build accessibility tree from page using locators
   */
  private async buildAccessibilityTree(page: Page): Promise<AccessibilityNode[]> {
    this.refMap.clear();
    this.refCounter = 0;

    const nodes: AccessibilityNode[] = [];

    // Define interactive element types to find
    const elementQueries = [
      { role: 'heading', selector: 'h1, h2, h3, h4, h5, h6' },
      { role: 'link', selector: 'a[href]' },
      { role: 'button', selector: 'button, [role="button"], input[type="submit"], input[type="button"]' },
      { role: 'textbox', selector: 'input[type="text"], input[type="email"], input[type="password"], input[type="search"], input[type="tel"], input[type="url"], input:not([type]), textarea' },
      { role: 'checkbox', selector: 'input[type="checkbox"]' },
      { role: 'radio', selector: 'input[type="radio"]' },
      { role: 'combobox', selector: 'select' },
      { role: 'searchbox', selector: 'input[type="search"], [role="searchbox"]' },
      { role: 'img', selector: 'img[alt]' },
      { role: 'navigation', selector: 'nav, [role="navigation"]' },
      { role: 'main', selector: 'main, [role="main"]' },
    ];

    for (const query of elementQueries) {
      try {
        const elements = page.locator(query.selector);
        const count = await elements.count();

        for (let i = 0; i < Math.min(count, 50); i++) { // Limit to 50 per type
          try {
            const element = elements.nth(i);
            const isVisible = await element.isVisible().catch(() => false);
            if (!isVisible) continue;

            const ref = this.generateRef();

            // Get element properties
            const name = await this.getElementName(element, query.role);
            const value = await element.inputValue().catch(() => undefined);
            const isDisabled = await element.isDisabled().catch(() => false);

            // Get heading level if applicable
            let level: number | undefined;
            if (query.role === 'heading') {
              const tagName = await element.evaluate(el => el.tagName.toLowerCase());
              level = parseInt(tagName.replace('h', ''), 10);
            }

            // Get checked state for checkboxes/radios
            let checked: boolean | undefined;
            if (query.role === 'checkbox' || query.role === 'radio') {
              checked = await element.isChecked().catch(() => undefined);
            }

            const accessNode: AccessibilityNode = {
              role: query.role,
              name: name || '',
              ref,
              value,
              disabled: isDisabled || undefined,
              level,
              checked,
            };

            // Store reference for interaction
            this.refMap.set(ref, {
              role: query.role,
              name,
              selector: query.selector,
              index: i,
            });

            if (name || query.role === 'textbox') {
              nodes.push(accessNode);
            }
          } catch (e) {
            // Skip elements that can't be processed
          }
        }
      } catch (e) {
        // Skip queries that fail
      }
    }

    return nodes;
  }

  /**
   * Get accessible name for an element
   */
  private async getElementName(element: any, role: string): Promise<string> {
    try {
      // Try aria-label first
      const ariaLabel = await element.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel;

      // Try title
      const title = await element.getAttribute('title');
      if (title) return title;

      // For inputs, try placeholder or associated label
      if (role === 'textbox' || role === 'searchbox' || role === 'combobox') {
        const placeholder = await element.getAttribute('placeholder');
        if (placeholder) return placeholder;

        const id = await element.getAttribute('id');
        if (id) {
          const page = element.page();
          const label = page.locator(`label[for="${id}"]`);
          const labelText = await label.textContent().catch(() => null);
          if (labelText) return labelText.trim();
        }
      }

      // For images, get alt text
      if (role === 'img') {
        const alt = await element.getAttribute('alt');
        if (alt) return alt;
      }

      // Get inner text (limited)
      const text = await element.textContent().catch(() => '');
      return (text || '').trim().slice(0, 100);
    } catch {
      return '';
    }
  }

  /**
   * Find element by accessibility ref using stored selector and index
   */
  private async findElementByRef(page: Page, ref: string): Promise<any> {
    const nodeInfo = this.refMap.get(ref);
    if (!nodeInfo) {
      throw new Error(`Element ref "${ref}" not found. Please get a fresh snapshot.`);
    }

    const { role, name, selector, index } = nodeInfo;

    // Try to find by stored selector and index first
    if (selector !== undefined && index !== undefined) {
      try {
        const elements = page.locator(selector);
        const element = elements.nth(index);
        const isVisible = await element.isVisible().catch(() => false);
        if (isVisible) {
          return element;
        }
      } catch (e) {
        // Fall through to other methods
      }
    }

    // Try to find by role and name
    try {
      const roleMap: Record<string, string> = {
        textbox: 'textbox',
        searchbox: 'searchbox',
        button: 'button',
        link: 'link',
        checkbox: 'checkbox',
        radio: 'radio',
        combobox: 'combobox',
        heading: 'heading',
      };

      const playwrightRole = roleMap[role];
      if (playwrightRole && name) {
        const element = page.getByRole(playwrightRole as any, { name, exact: false });
        const count = await element.count();
        if (count > 0) {
          return element.first();
        }
      }
    } catch (e) {
      // Role might not be supported, try other methods
    }

    // Fallback: try by text
    if (name) {
      const byText = page.getByText(name, { exact: false });
      const count = await byText.count();
      if (count > 0) {
        return byText.first();
      }
    }

    throw new Error(`Could not locate element with ref "${ref}" (role: ${role}, name: ${name})`);
  }

  /**
   * Format accessibility tree for LLM consumption
   */
  formatAccessibilityTree(nodes: AccessibilityNode[], indent = 0): string {
    const lines: string[] = [];

    for (const node of nodes) {
      const prefix = '  '.repeat(indent);
      let line = `${prefix}- ${node.role}`;

      if (node.name) {
        line += ` "${node.name}"`;
      }

      line += ` [ref=${node.ref}]`;

      if (node.value) {
        line += ` value="${node.value}"`;
      }
      if (node.checked !== undefined) {
        line += ` checked=${node.checked}`;
      }
      if (node.disabled) {
        line += ` (disabled)`;
      }
      if (node.level !== undefined) {
        line += ` level=${node.level}`;
      }

      lines.push(line);

      if (node.children) {
        lines.push(this.formatAccessibilityTree(node.children, indent + 1));
      }
    }

    return lines.join('\n');
  }

  /**
   * Get all browser tools for the agent
   */
  getTools(): Record<string, any> {
    return {
      browserNavigate: this.createNavigateTool(),
      browserSnapshot: this.createSnapshotTool(),
      browserClick: this.createClickTool(),
      browserType: this.createTypeTool(),
      browserScroll: this.createScrollTool(),
      browserScreenshot: this.createScreenshotTool(),
      browserExtractVision: this.createExtractVisionTool(),
      browserAnswerVision: this.createAnswerVisionTool(),
      browserExtractText: this.createExtractTextTool(),
      browserWait: this.createWaitTool(),
      browserClose: this.createCloseTool(),
    };
  }

  // ===== Tool Creators =====

  private createNavigateTool() {
    return tool(
      async (input: { url: string }) => {
        try {
          const page = await this.ensureBrowser();
          await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 15000 });

          const title = await page.title();
          const currentUrl = page.url();

          this.logger.log(`Navigated to: ${currentUrl}`);

          return JSON.stringify({
            success: true,
            url: currentUrl,
            title,
            message: `Successfully navigated to "${title}"`,
          });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.logger.error(`Navigation failed: ${errorMsg}`);
          return JSON.stringify({
            success: false,
            error: errorMsg,
          });
        }
      },
      {
        name: 'browserNavigate',
        description: 'Navigate to a URL in the browser. Use this to open a webpage.',
        schema: z.object({
          url: z.string().describe('The URL to navigate to (must include protocol like https://)'),
        }),
      },
    );
  }

  private createSnapshotTool() {
    return tool(
      async () => {
        try {
          const page = await this.ensureBrowser();
          const url = page.url();
          const title = await page.title();
          const tree = await this.buildAccessibilityTree(page);
          const formattedTree = this.formatAccessibilityTree(tree);

          return JSON.stringify({
            success: true,
            url,
            title,
            snapshot: formattedTree,
            message: `Page snapshot captured. Use the [ref=...] values to interact with elements.`,
          });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.logger.error(`Snapshot failed: ${errorMsg}`);
          return JSON.stringify({
            success: false,
            error: errorMsg,
          });
        }
      },
      {
        name: 'browserSnapshot',
        description: 'Get an accessibility snapshot of the current page. Returns a structured representation of all interactive elements with their refs. Use this to understand the page structure before clicking or typing.',
      },
    );
  }

  private createClickTool() {
    return tool(
      async (input: { ref: string; description?: string }) => {
        try {
          const page = await this.ensureBrowser();
          const element = await this.findElementByRef(page, input.ref);

          await element.click({ timeout: 10000 });

          // Wait for potential navigation or page updates
          await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => { });

          const newUrl = page.url();
          const newTitle = await page.title();

          this.logger.log(`Clicked element ref=${input.ref}`);

          return JSON.stringify({
            success: true,
            message: `Clicked element. Current page: "${newTitle}"`,
            currentUrl: newUrl,
            currentTitle: newTitle,
          });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.logger.error(`Click failed: ${errorMsg}`);
          return JSON.stringify({
            success: false,
            error: errorMsg,
            hint: 'Try getting a fresh snapshot and using an updated ref.',
          });
        }
      },
      {
        name: 'browserClick',
        description: 'Click an element on the page by its ref. Get refs from browserSnapshot first.',
        schema: z.object({
          ref: z.string().describe('The element ref from the snapshot (e.g., "e5")'),
          description: z.string().optional().describe('Description of what you are clicking for logging'),
        }),
      },
    );
  }

  private createTypeTool() {
    return tool(
      async (input: { ref: string; text: string; clearFirst?: boolean; pressEnter?: boolean }) => {
        try {
          const page = await this.ensureBrowser();
          const element = await this.findElementByRef(page, input.ref);

          if (input.clearFirst) {
            await element.fill('');
          }

          await element.fill(input.text);

          if (input.pressEnter) {
            await element.press('Enter');
            await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => { });
          }

          this.logger.log(`Typed text into ref=${input.ref}`);

          return JSON.stringify({
            success: true,
            message: `Typed "${input.text}" into element`,
          });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.logger.error(`Type failed: ${errorMsg}`);
          return JSON.stringify({
            success: false,
            error: errorMsg,
          });
        }
      },
      {
        name: 'browserType',
        description: 'Type text into an input field by its ref. Get refs from browserSnapshot first.',
        schema: z.object({
          ref: z.string().describe('The element ref from the snapshot (e.g., "e5")'),
          text: z.string().describe('The text to type'),
          clearFirst: z.boolean().optional().describe('Clear the field before typing (default: false)'),
          pressEnter: z.boolean().optional().describe('Press Enter after typing (default: false)'),
        }),
      },
    );
  }

  private createScrollTool() {
    return tool(
      async (input: { direction: 'up' | 'down'; amount?: number }) => {
        try {
          const page = await this.ensureBrowser();
          const scrollAmount = input.amount || 500;
          const delta = input.direction === 'down' ? scrollAmount : -scrollAmount;

          await page.mouse.wheel(0, delta);
          await page.waitForTimeout(500); // Wait for scroll to complete

          this.logger.log(`Scrolled ${input.direction} by ${scrollAmount}px`);

          return JSON.stringify({
            success: true,
            message: `Scrolled ${input.direction} by ${scrollAmount}px`,
          });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.logger.error(`Scroll failed: ${errorMsg}`);
          return JSON.stringify({
            success: false,
            error: errorMsg,
          });
        }
      },
      {
        name: 'browserScroll',
        description: 'Scroll the page up or down',
        schema: z.object({
          direction: z.enum(['up', 'down']).describe('Direction to scroll'),
          amount: z.number().optional().describe('Pixels to scroll (default: 500)'),
        }),
      },
    );
  }

  private createScreenshotTool() {
    return tool(
      async (input: { filename?: string; fullPage?: boolean }) => {
        try {
          const page = await this.ensureBrowser();
          const timestamp = Date.now();

          // Ensure filename has .png extension
          let filename = input.filename;
          if (!filename || filename === 'null' || filename === 'undefined') {
            filename = `screenshot-${timestamp}.png`;
          } else if (!filename.endsWith('.png') && !filename.endsWith('.jpg') && !filename.endsWith('.jpeg')) {
            filename = `${filename}.png`;
          }

          const filepath = path.join(this.screenshotDir, filename);

          // wait for 2 seconds
          await page.waitForTimeout(2000);

          await page.screenshot({
            path: filepath,
            fullPage: input.fullPage ?? false,
            type: 'png',
          });

          this.logger.log(`Screenshot saved: ${filepath}`);

          return JSON.stringify({
            success: true,
            filepath,
            filename,
            message: `Screenshot saved to ${filepath}`,
          });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.logger.error(`Screenshot failed: ${errorMsg}`);
          return JSON.stringify({
            success: false,
            error: errorMsg,
          });
        }
      },
      {
        name: 'browserScreenshot',
        description: 'Take a screenshot of the current page',
        schema: z.object({
          filename: z.string().optional().describe('Filename for the screenshot (default: auto-generated)'),
          fullPage: z.boolean().optional().describe('Capture full page including scroll (default: false)'),
        }),
      },
    );
  }

  private createExtractVisionTool() {
    return tool(
      async (input: { description: string; fullPage?: boolean }) => {
        try {
          const page = await this.ensureBrowser();

          // Take a screenshot first
          const timestamp = Date.now();
          const filename = `vision-extract-${timestamp}.png`;
          const filepath = path.join(this.screenshotDir, filename);

          // wait for 2 seconds
          await page.waitForTimeout(2000);

          await page.screenshot({
            path: filepath,
            fullPage: input.fullPage ?? false,
            type: 'png',
          });

          this.logger.log(`Screenshot taken for vision extraction: ${filepath}`);

          // Read the screenshot as base64
          const imageBuffer = fs.readFileSync(filepath);
          const base64Image = imageBuffer.toString('base64');

          // Use vision model to extract data
          const visionModel = new ChatOpenAI({
            model: this.configService.getConfig().vision_model,
            temperature: 0,
            configuration: {
              baseURL: 'https://openrouter.ai/api/v1',
              apiKey: process.env.OPENROUTER_API_KEY,
            },
          });

          const pageUrl = page.url();
          const pageTitle = await page.title();

          const response = await visionModel.invoke([
            new HumanMessage({
              content: [
                {
                  type: 'text',
                  text: `You are a data extraction assistant. Analyze this screenshot of a webpage and extract the requested information.

Page URL: ${pageUrl}
Page Title: ${pageTitle}

TASK: ${input.description}

Instructions:
1. Look at the screenshot carefully
2. Find and extract EXACTLY what was requested
3. Return the extracted data in a clear, structured format
4. If the data contains numbers, prices, rates, etc., preserve them exactly as shown
5. If you cannot find the requested data in the screenshot, say "NOT_FOUND: [reason]"

Return ONLY the extracted data, nothing else. Be concise and accurate.`,
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/png;base64,${base64Image}`,
                  },
                },
              ],
            }),
          ]);

          const extractedData = typeof response.content === 'string'
            ? response.content
            : String(response.content);

          this.logger.log(`Vision extraction completed: ${extractedData.slice(0, 100)}...`);

          // Check if extraction failed
          const notFound = extractedData.startsWith('NOT_FOUND:');

          return JSON.stringify({
            success: !notFound,
            extractedData: notFound ? null : extractedData,
            error: notFound ? extractedData : null,
            screenshotPath: filepath,
            method: 'vision',
            hint: notFound ? 'Vision extraction could not find the data. Try browserExtractText for HTML-based extraction.' : null,
          });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.logger.error(`Vision extraction failed: ${errorMsg}`);
          return JSON.stringify({
            success: false,
            error: errorMsg,
            method: 'vision',
            hint: 'Vision extraction failed. Try browserExtractText as a fallback.',
          });
        }
      },
      {
        name: 'browserExtractVision',
        description: 'Extract data from the page using AI vision analysis (PREFERRED method). Takes a screenshot and uses AI to read and extract the requested information. Best for: prices, rates, tables, visible text, numbers, any data shown on screen.',
        schema: z.object({
          description: z.string().describe('What data to extract from the page (e.g., "USD exchange rate", "product price", "table of stock prices")'),
          fullPage: z.boolean().optional().describe('Capture full scrollable page (default: false, just visible viewport)'),
        }),
      },
    );
  }

  /**
   * Take a screenshot and ask the vision model to answer a question about what is visible.
   * Use for: "do you see X?", "is there Y?", "check if ..." – returns a natural-language answer.
   */
  private createAnswerVisionTool() {
    return tool(
      async (input: { question: string; fullPage?: boolean }) => {
        try {
          const page = await this.ensureBrowser();

          const timestamp = Date.now();
          const filename = `vision-answer-${timestamp}.png`;
          const filepath = path.join(this.screenshotDir, filename);

          await page.waitForTimeout(2000);

          await page.screenshot({
            path: filepath,
            fullPage: input.fullPage ?? false,
            type: 'png',
          });

          this.logger.log(`Screenshot taken for vision QA: ${filepath}`);

          const imageBuffer = fs.readFileSync(filepath);
          const base64Image = imageBuffer.toString('base64');

          const visionModel = new ChatOpenAI({
            model: this.configService.getConfig().vision_model,
            temperature: 0,
            configuration: {
              baseURL: 'https://openrouter.ai/api/v1',
              apiKey: process.env.OPENROUTER_API_KEY,
            },
          });

          const pageUrl = page.url();
          const pageTitle = await page.title();

          const response = await visionModel.invoke([
            new HumanMessage({
              content: [
                {
                  type: 'text',
                  text: `You are looking at a screenshot of a webpage. Answer the user's question about what you see.

Page URL: ${pageUrl}
Page Title: ${pageTitle}

QUESTION: ${input.question}

Instructions:
1. Look at the screenshot carefully.
2. Answer the question in a clear, concise way (one or a few sentences).
3. If the question is "do you see X?" or "is there Y?", answer Yes/No and briefly describe what you see or don't see.
4. If you cannot tell from the screenshot, say "I cannot determine from the screenshot" and why.
5. Do not make up content that is not visible.`,
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/png;base64,${base64Image}`,
                  },
                },
              ],
            }),
          ]);

          const answer = typeof response.content === 'string'
            ? response.content
            : String(response.content);

          this.logger.log(`Vision QA completed: ${answer.slice(0, 80)}...`);

          return JSON.stringify({
            success: true,
            answer,
            screenshotPath: filepath,
            method: 'vision_answer',
          });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.logger.error(`Vision QA failed: ${errorMsg}`);
          return JSON.stringify({
            success: false,
            error: errorMsg,
            method: 'vision_answer',
          });
        }
      },
      {
        name: 'browserAnswerVision',
        description: 'Answer a question about what is visible on the current page. Takes a screenshot and uses AI vision to answer (e.g. "Do you see a sale banner?", "Is there a login form?", "What is the main headline?"). Use for check/see/is there/tell me if style questions.',
        schema: z.object({
          question: z.string().describe('The question to answer about the page (e.g. "Do you see a sale banner?", "Is there a login form?")'),
          fullPage: z.boolean().optional().describe('Capture full scrollable page (default: false)'),
        }),
      },
    );
  }

  private createExtractTextTool() {
    return tool(
      async (input: { selector?: string }) => {
        try {
          const page = await this.ensureBrowser();

          let text: string;
          if (input.selector) {
            // Use allTextContents() to handle multiple matching elements
            const element = page.locator(input.selector);
            const texts = await element.allTextContents();
            text = texts.join('\n');
          } else {
            // Get full page text
            text = await page.locator('body').innerText() || '';
          }

          // Clean up the text
          text = text
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 10000); // Limit to 10k chars

          this.logger.log(`Extracted ${text.length} chars of text`);

          return JSON.stringify({
            success: true,
            text,
            length: text.length,
            method: 'html',
          });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.logger.error(`Extract text failed: ${errorMsg}`);
          return JSON.stringify({
            success: false,
            error: errorMsg,
            method: 'html',
          });
        }
      },
      {
        name: 'browserExtractText',
        description: 'Extract text content from HTML (FALLBACK method). Use this only if browserExtractVision fails or for hidden elements. For visible page data, prefer browserExtractVision.',
        schema: z.object({
          selector: z.string().optional().describe('CSS selector to extract text from (default: entire page body)'),
        }),
      },
    );
  }

  private createWaitTool() {
    const MAX_WAIT_MS = 5000; // Maximum wait time: 5 seconds

    return tool(
      async (input: { milliseconds?: number; forText?: string; forSelector?: string }) => {
        try {
          const page = await this.ensureBrowser();

          if (input.forText) {
            await page.waitForSelector(`text=${input.forText}`, { timeout: MAX_WAIT_MS });
            return JSON.stringify({
              success: true,
              message: `Found text: "${input.forText}"`,
            });
          }

          if (input.forSelector) {
            await page.waitForSelector(input.forSelector, { timeout: MAX_WAIT_MS });
            return JSON.stringify({
              success: true,
              message: `Found element matching: "${input.forSelector}"`,
            });
          }

          // Cap the wait time at MAX_WAIT_MS (5 seconds)
          const requestedMs = input.milliseconds || 1000;
          const ms = Math.min(requestedMs, MAX_WAIT_MS);

          if (requestedMs > MAX_WAIT_MS) {
            this.logger.warn(`Wait time capped from ${requestedMs}ms to ${MAX_WAIT_MS}ms`);
          }

          await page.waitForTimeout(ms);
          return JSON.stringify({
            success: true,
            message: `Waited ${ms}ms${requestedMs > MAX_WAIT_MS ? ` (capped from ${requestedMs}ms)` : ''}`,
          });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.logger.error(`Wait failed: ${errorMsg}`);
          return JSON.stringify({
            success: false,
            error: errorMsg,
          });
        }
      },
      {
        name: 'browserWait',
        description: 'Wait for a condition or specified time (max 5 seconds)',
        schema: z.object({
          milliseconds: z.number().optional().describe('Time to wait in milliseconds (max 5000ms / 5 seconds)'),
          forText: z.string().optional().describe('Wait for this text to appear on page (max 5 second timeout)'),
          forSelector: z.string().optional().describe('Wait for this CSS selector to appear (max 5 second timeout)'),
        }),
      },
    );
  }

  private createCloseTool() {
    return tool(
      async () => {
        try {
          await this.closeBrowser();
          return JSON.stringify({
            success: true,
            message: 'Browser closed successfully',
          });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.logger.error(`Close browser failed: ${errorMsg}`);
          return JSON.stringify({
            success: false,
            error: errorMsg,
          });
        }
      },
      {
        name: 'browserClose',
        description: 'Close the browser. Use this when you are done with browser tasks.',
      },
    );
  }
}
