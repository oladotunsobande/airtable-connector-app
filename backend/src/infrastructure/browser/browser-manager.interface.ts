import type { Browser, Page } from 'puppeteer';

export interface IBrowserManager {
  getBrowser(): Promise<Browser>;
  newPage(): Promise<Page>;
  close(): Promise<void>;
}
