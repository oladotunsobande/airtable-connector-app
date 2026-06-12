import type { Logger } from '../../../core/logger/index.js';
import type { IAirtableApiService, AirtableBase } from './airtable-api.service.interface.js';
import type { IBaseRepository } from '../models/base.repository.interface.js';
import type { ITableRepository } from '../models/table.repository.interface.js';
import type { IPageRepository } from '../models/page.repository.interface.js';

export interface IIngestService {
  /**
   * Fetches all bases from the Airtable API and upserts them into the DB.
   * Returns the persisted base documents.
   */
  ingestBases(): Promise<AirtableBase[]>;

  /**
   * Fetches all tables for a base and upserts them.
   * Returns the count of tables processed.
   */
  ingestTables(baseId: string): Promise<number>;

  /**
   * Fetches all records (all pages) for a table and upserts them.
   * Returns the total count of records processed.
   */
  ingestRecords(baseId: string, tableId: string): Promise<number>;
}

export class IngestService implements IIngestService {
  constructor(
    private readonly apiService: IAirtableApiService,
    private readonly baseRepository: IBaseRepository,
    private readonly tableRepository: ITableRepository,
    private readonly pageRepository: IPageRepository,
    private readonly log: Logger,
  ) {}

  async ingestBases(): Promise<AirtableBase[]> {
    const bases = await this.apiService.getBases();

    await Promise.all(
      bases.map((b) =>
        this.baseRepository.upsert({
          airtableId: b.id,
          name: b.name,
          permissionLevel: b.permissionLevel,
        }),
      ),
    );

    this.log.info('Ingested bases', { count: bases.length });
    return bases;
  }

  async ingestTables(baseId: string): Promise<number> {
    const tables = await this.apiService.getTables(baseId);

    await Promise.all(
      tables.map((t) =>
        this.tableRepository.upsert({
          airtableId: t.id,
          baseId,
          name: t.name,
          primaryFieldId: t.primaryFieldId,
          fields: t.fields,
        }),
      ),
    );

    this.log.info('Ingested tables', { baseId, count: tables.length });
    return tables.length;
  }

  async ingestRecords(baseId: string, tableId: string): Promise<number> {
    let total = 0;

    for await (const batch of this.apiService.getRecords(baseId, tableId)) {
      await Promise.all(
        batch.map((r) =>
          this.pageRepository.upsert({
            airtableId: r.id,
            baseId,
            tableId,
            fields: r.fields,
            createdTime: new Date(r.createdTime),
          }),
        ),
      );
      total += batch.length;
    }

    this.log.info('Ingested records', { baseId, tableId, total });
    return total;
  }
}
