import {
  Component,
  inject,
  signal,
  effect,
  ViewChild,
  OnInit,
  OnDestroy,
  ElementRef,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AgGridAngular } from 'ag-grid-angular';
import { AgCharts } from 'ag-charts-angular';
import type {
  ColDef,
  GridApi,
  GridReadyEvent,
  IDatasource,
  IGetRowsParams,
  SortChangedEvent,
} from 'ag-grid-community';
import type { AgChartOptions } from 'ag-charts-community';
import { ApiService } from '../../core/api/api.service';
import { ScrapeRunStore } from '../../core/scrape-run/scrape-run.store';
import type { EntityMeta } from '../../core/models/api.models';

const PAGE_SIZE = 50;

@Component({
  selector: 'app-data-grid',
  imports: [
    DecimalPipe,
    FormsModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatIconModule,
    MatProgressBarModule,
    MatButtonModule,
    MatTooltipModule,
    AgGridAngular,
    AgCharts,
  ],
  templateUrl: './data-grid.component.html',
  styleUrl: './data-grid.component.scss',
})
export class DataGridComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly scrapeRunStore = inject(ScrapeRunStore);

  @ViewChild('searchInput') searchInputRef?: ElementRef<HTMLInputElement>;

  // ── State ──────────────────────────────────────────────────────────────────

  entities = signal<EntityMeta[]>([]);
  colDefs = signal<ColDef[]>([]);
  loading = signal(false);
  totalRows = signal(0);
  searchText = signal('');
  chartOptions = signal<AgChartOptions | null>(null);

  selectedEntity = 'bases';

  readonly PAGE_SIZE = PAGE_SIZE;

  readonly defaultColDef: ColDef = {
    sortable: true,
    resizable: true,
    minWidth: 120,
    filter: false,
    cellStyle: { fontSize: '13px' },
  };

  private gridApi?: GridApi;
  private sortField?: string;
  private sortDir?: 'asc' | 'desc';
  private searchDebounce?: ReturnType<typeof setTimeout>;

  constructor() {
    // Refresh grid automatically when a scraping run completes
    effect(() => {
      if (this.scrapeRunStore.completedAt() !== null) {
        this.refreshDatasource();
      }
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  ngOnInit(): void {
    this.fetchEntities();
  }

  ngOnDestroy(): void {
    clearTimeout(this.searchDebounce);
  }

  fetchEntities() {
    this.api.getEntities().subscribe({
      next: (list) => this.entities.set(list),
    });
  }

  // ── Grid events ────────────────────────────────────────────────────────────

  onGridReady(event: GridReadyEvent): void {
    this.gridApi = event.api;
    this.refreshDatasource();
  }

  onSortChanged(event: SortChangedEvent): void {
    const sortState = event.api.getColumnState().find((c) => c.sort != null);
    this.sortField = sortState?.colId ?? undefined;
    this.sortDir = (sortState?.sort as 'asc' | 'desc' | null) ?? undefined;
    this.refreshDatasource();
  }

  // ── User interactions ──────────────────────────────────────────────────────

  onEntityChange(entity: string): void {
    this.selectedEntity = entity;
    this.sortField = undefined;
    this.sortDir = undefined;
    this.colDefs.set([]);
    this.totalRows.set(0);
    this.chartOptions.set(null);
    this.refreshDatasource();
  }

  onSearchChange(text: string): void {
    clearTimeout(this.searchDebounce);
    this.searchText.set(text);
    this.searchDebounce = setTimeout(() => this.refreshDatasource(), 400);
  }

  clearSearch(): void {
    this.searchText.set('');
    this.refreshDatasource();
    this.searchInputRef?.nativeElement.focus();
  }

  refreshGrid(): void {
    this.fetchEntities();
    this.refreshDatasource();
  }

  // ── Datasource ─────────────────────────────────────────────────────────────

  private refreshDatasource(): void {
    if (!this.gridApi) return;
    this.gridApi.setGridOption('datasource', this.buildDatasource());
  }

  private buildDatasource(): IDatasource {
    const entityName = this.selectedEntity;
    const search = this.searchText();
    const sortField = this.sortField;
    const sortDir = this.sortDir;
    const isFirst = { done: false }; // track first call per datasource instance

    return {
      getRows: (params: IGetRowsParams) => {
        this.loading.set(true);

        const page = Math.floor(params.startRow / PAGE_SIZE) + 1;

        // Sort from params overrides the component-level sort state
        const activeSortModel = params.sortModel[0];
        const sf = activeSortModel?.colId ?? sortField;
        const sd =
          (activeSortModel?.sort as 'asc' | 'desc' | undefined) ?? sortDir;

        this.api
          .getEntityData(entityName, {
            page,
            pageSize: PAGE_SIZE,
            ...(search ? { search } : {}),
            ...(sf ? { sortField: sf, ...(sd ? { sortDir: sd } : {}) } : {}),
          })
          .subscribe({
            next: (result) => {
              this.loading.set(false);
              this.totalRows.set(result.total);

              if (!isFirst.done && result.fields.length > 0) {
                isFirst.done = true;
                this.setColDefs(result.fields);
                // if (entityName === 'revisionHistory') {
                //   this.buildChart(result.data);
                // }
              }

              params.successCallback(result.data, result.total);
            },
            error: () => {
              this.loading.set(false);
              params.failCallback();
            },
          });
      },
    };
  }

  // ── Column defs ────────────────────────────────────────────────────────────

  private setColDefs(fields: string[]): void {
    const defs: ColDef[] = fields.map((field) => ({
      field,
      headerName: toHeaderName(field),
      sortable: true,
      resizable: true,
      minWidth: 120,
      flex: field === 'airtableId' || field === 'uuid' ? 0 : 1,
      valueFormatter: ({ value }) => formatCellValue(value),
    }));
    this.colDefs.set(defs);
  }

  // ── Chart ──────────────────────────────────────────────────────────────────

  private buildChart(data: Record<string, unknown>[]): void {
    const counts: Record<string, number> = {};
    for (const row of data) {
      const key = String(row['columnType'] ?? 'Unknown');
      counts[key] = (counts[key] ?? 0) + 1;
    }

    const chartData = Object.entries(counts).map(([columnType, count]) => ({
      columnType,
      count,
    }));

    this.chartOptions.set({
      data: chartData,
      series: [
        {
          type: 'bar',
          xKey: 'columnType',
          yKey: 'count',
          yName: 'Changes',
          cornerRadiusTopLeft: 4,
          cornerRadiusTopRight: 4,
        },
      ],
      axes: [
        { type: 'category', position: 'bottom', label: { rotation: 0 } },
        {
          type: 'number',
          position: 'left',
          label: { formatter: ({ value }: { value: number }) => String(value) },
        },
      ],
      legend: { enabled: false },
      padding: { top: 8, right: 16, bottom: 8, left: 16 },
    } as unknown as AgChartOptions);
  }
}

// ── Pure helpers ───────────────────────────────────────────────────────────────

function toHeaderName(field: string): string {
  return field
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toLocaleString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
