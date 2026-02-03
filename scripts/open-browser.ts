/**
 * Opens the browser with the same persistent profile used by the bot.
 * Use this to manually login to websites, then the bot can use those sessions.
 * 
 * Usage: npm run browser
 */

import { chromium, Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';

const userDataDir = path.join(process.cwd(), 'data', 'browser-profile');

// Stealth args to avoid detection (extensions enabled for manual use)
const stealthArgs = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--disable-gpu',
  '--window-size=1280,720',
  '--start-maximized',
  '--mute-audio',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-infobars',
  '--disable-breakpad',
  '--disable-hang-monitor',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-sync',
  '--disable-translate',
  '--metrics-recording-only',
  '--no-first-run',
  '--safebrowsing-disable-auto-update',
  // Enable extensions
  '--enable-extensions',
];

async function applyStealthScripts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ],
    });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    (window as any).chrome = { runtime: {}, loadTimes: function() {}, csi: function() {}, app: {} };
  });
}

async function main() {
  // Ensure directory exists
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  console.log('Opening stealth browser with persistent profile...');
  console.log(`Profile location: ${userDataDir}`);
  console.log('');
  console.log('You can now:');
  console.log('  - Login to websites (sessions will be saved)');
  console.log('  - Install Chrome extensions from chrome.google.com/webstore');
  console.log('');
  console.log('Press Ctrl+C or close the browser window when done.');
  console.log('');

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: stealthArgs,
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    permissions: ['geolocation', 'notifications'],
    ignoreHTTPSErrors: true,
    bypassCSP: true,
  });

  const page = context.pages()[0] || await context.newPage();
  await applyStealthScripts(page);
  
  // Navigate to a blank page
  await page.goto('about:blank');

  // Wait for browser to be closed
  await new Promise<void>((resolve) => {
    context.on('close', () => {
      console.log('Browser closed. Sessions saved.');
      resolve();
    });
  });
}

main().catch(console.error);
