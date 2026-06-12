import { HttpClientError } from '../../core/errors/index.js';
import type { Logger } from '../../core/logger/index.js';
import type { IHttpClient, RequestOptions } from './http-client.interface.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(headers: Headers, defaultMs: number): number {
  const raw = headers.get('retry-after');
  if (!raw) return defaultMs;
  // Retry-After is either a delay-seconds integer or an HTTP-date string.
  const seconds = Number(raw);
  if (!isNaN(seconds)) return seconds * 1000;
  const date = new Date(raw).getTime();
  if (!isNaN(date)) return Math.max(0, date - Date.now());
  return defaultMs;
}

export class FetchHttpClient implements IHttpClient {
  constructor(private readonly log: Logger) {}

  async get<T>(url: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('GET', url, undefined, options);
  }

  async post<T>(url: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('POST', url, body, options);
  }

  async put<T>(url: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('PUT', url, body, options);
  }

  async delete<T>(url: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('DELETE', url, undefined, options);
  }

  private async request<T>(
    method: string,
    url: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...options?.headers,
    };

    let attempt = 0;
    let backoffMs = 1_000;

    while (attempt <= MAX_RETRIES) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const signal = options?.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;

      try {
        const init: RequestInit = { method, headers, signal };
        if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);

        const response = await fetch(url, init);

        clearTimeout(timer);

        if (response.ok) {
          const text = await response.text();
          return text ? (JSON.parse(text) as T) : ({} as T);
        }

        if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_RETRIES) {
          const waitMs = parseRetryAfterMs(response.headers, backoffMs);
          this.log.warn('Retryable HTTP error — backing off', {
            url,
            status: response.status,
            attempt,
            waitMs,
          });
          await delay(waitMs);
          backoffMs = Math.min(backoffMs * 2, 30_000);
          attempt++;
          continue;
        }

        let errorBody: unknown;
        try {
          errorBody = await response.json();
        } catch {
          errorBody = await response.text().catch(() => null);
        }

        throw new HttpClientError(
          `HTTP ${response.status} ${response.statusText} — ${method} ${url}`,
          response.status,
          errorBody,
        );
      } catch (err) {
        clearTimeout(timer);

        if (err instanceof HttpClientError) throw err;

        if (attempt < MAX_RETRIES) {
          this.log.warn('Network error — retrying', {
            url,
            attempt,
            error: err instanceof Error ? err.message : String(err),
          });
          await delay(backoffMs);
          backoffMs = Math.min(backoffMs * 2, 30_000);
          attempt++;
          continue;
        }

        throw new HttpClientError(
          `Network error after ${MAX_RETRIES} retries — ${method} ${url}`,
          0,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Should never reach here but TS needs the return.
    throw new HttpClientError(`Exhausted retries — ${method} ${url}`, 0);
  }
}
