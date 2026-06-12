import type { AppConfig } from '../../../config/index.js';
import type { Logger } from '../../../core/logger/index.js';
import type { IHttpClient } from '../../../infrastructure/http/http-client.interface.js';
import type { IRateLimiter } from '../../../infrastructure/rate-limit/rate-limiter.interface.js';
import type { ITokenProvider } from '../auth/token-provider.interface.js';
import type {
  IAirtableApiService,
  AirtableBase,
  AirtableTable,
  AirtableRecord,
} from './airtable-api.service.interface.js';

// ── Airtable API response shapes ─────────────────────────────────────────────

interface BasesResponse {
  bases: Array<{ id: string; name: string; permissionLevel: string }>;
  offset?: string;
}

interface TablesResponse {
  tables: Array<{
    id: string;
    name: string;
    primaryFieldId: string;
    fields: Array<{ id: string; name: string; type: string; options?: Record<string, unknown> }>;
  }>;
}

interface RecordsResponse {
  records: Array<{ id: string; createdTime: string; fields: Record<string, unknown> }>;
  offset?: string;
}

/**
 * Rate-limit key used for all API calls — one shared bucket across the whole
 * `api.airtable.com` domain (Airtable's limit is per-base but we use a global
 * key here since we only have one account). The cron pipeline fans out
 * per-base workers that each call this service, so the limiter naturally
 * back-pressures concurrent base processing.
 */
const RATE_LIMIT_KEY = 'api.airtable.com';

export class AirtableApiService implements IAirtableApiService {
  constructor(
    private readonly config: AppConfig,
    private readonly http: IHttpClient,
    private readonly tokenProvider: ITokenProvider,
    private readonly rateLimiter: IRateLimiter,
    private readonly log: Logger,
  ) {}

  // ── Public API ──────────────────────────────────────────────────────────────

  async getBases(): Promise<AirtableBase[]> {
    const bases: AirtableBase[] = [];
    let offset: string | undefined;

    do {
      const url = this.url('/meta/bases', offset ? { offset } : {});
      const response = await this.get<BasesResponse>(url);

      for (const b of response.bases) {
        bases.push({ id: b.id, name: b.name, permissionLevel: b.permissionLevel });
      }

      offset = response.offset;
    } while (offset);

    this.log.info('Fetched bases', { count: bases.length });
    return bases;
  }

  async getTables(baseId: string): Promise<AirtableTable[]> {
    const url = this.url(`/meta/bases/${baseId}/tables`);
    const response = await this.get<TablesResponse>(url);

    const tables: AirtableTable[] = response.tables.map((t) => ({
      id: t.id,
      name: t.name,
      primaryFieldId: t.primaryFieldId,
      fields: t.fields.map((f) => ({
        id: f.id,
        name: f.name,
        type: f.type,
        ...(f.options !== undefined ? { options: f.options } : {}),
      })),
    }));

    this.log.info('Fetched tables', { baseId, count: tables.length });
    return tables;
  }

  /**
   * Async generator that yields pages of records.
   * The caller iterates with `for await (const batch of apiService.getRecords(...))`.
   * Each yielded batch is one page from Airtable (up to 100 records).
   */
  async *getRecords(baseId: string, tableId: string): AsyncGenerator<AirtableRecord[]> {
    let offset: string | undefined;
    let pageCount = 0;

    do {
      const url = this.url(`/${baseId}/${tableId}`, offset ? { offset } : {});
      const response = await this.get<RecordsResponse>(url);

      const records: AirtableRecord[] = response.records.map((r) => ({
        id: r.id,
        createdTime: r.createdTime,
        fields: r.fields,
      }));

      pageCount++;
      this.log.debug('Fetched record page', { baseId, tableId, page: pageCount, count: records.length });

      yield records;

      offset = response.offset;
    } while (offset);

    this.log.info('Finished fetching records', { baseId, tableId, pages: pageCount });
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async get<T>(url: string): Promise<T> {
    await this.rateLimiter.acquire(RATE_LIMIT_KEY);
    const token = await this.tokenProvider.getAccessToken();
    return this.http.get<T>(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  private url(path: string, params: Record<string, string> = {}): string {
    const base = `${this.config.airtable.apiBaseUrl}${path}`;
    const qs = new URLSearchParams(params).toString();
    return qs ? `${base}?${qs}` : base;
  }
}
