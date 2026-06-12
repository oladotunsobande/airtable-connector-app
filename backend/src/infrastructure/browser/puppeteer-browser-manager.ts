import puppeteer, { type Browser, type Page } from 'puppeteer';
import type { IBrowserManager } from './browser-manager.interface.js';
import type { Logger } from '../../core/logger/index.js';

// Chromium flags needed for headless operation in Linux/Docker environments.
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--disable-gpu',
  '--no-first-run',
  '--no-zygote',
  '--disable-blink-features=AutomationControlled',
];

const REALISTIC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class PuppeteerBrowserManager implements IBrowserManager {
  private browser: Browser | null = null;

  constructor(private readonly log: Logger) {}

  async getBrowser(): Promise<Browser> {
    if (!this.browser?.connected) {
      this.log.info('Launching Puppeteer browser');
      this.browser = await puppeteer.launch({
        headless: true,
        args: LAUNCH_ARGS,
      });

      this.browser.on('disconnected', () => {
        this.log.warn('Browser disconnected');
        this.browser = null;
      });
    }
    return this.browser;
  }

  async newPage(): Promise<Page> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(REALISTIC_UA);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    return page;
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.log.info('Puppeteer browser closed');
    }
  }
}
