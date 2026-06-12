/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Model } from 'mongoose';
import { BaseModel } from '../../modules/airtable/models/schemas/base.schema.js';
import { TableModel } from '../../modules/airtable/models/schemas/table.schema.js';
import { PageModel } from '../../modules/airtable/models/schemas/page.schema.js';
import { RevisionHistoryModel } from '../../modules/airtable/models/schemas/revision-history.schema.js';
import { UserModel } from '../../modules/airtable/models/schemas/user.schema.js';
import type {
  IEntitiesService,
  EntityMeta,
  QueryOptions,
  EntityPage,
  FilterOp,
} from './entities.service.interface.js';

const EXCLUDED_KEYS = new Set(['_id', '__v', 'id']);

const MAX_PAGE_SIZE = 200;

interface EntityEntry {
  model: Model<any>;
  label: string;
}

const ENTITY_MAP: Record<string, EntityEntry> = {
  bases: { model: BaseModel as Model<any>, label: 'Bases' },
  tables: { model: TableModel as Model<any>, label: 'Tables' },
  pages: { model: PageModel as Model<any>, label: 'Pages' },
  revisionHistory: { model: RevisionHistoryModel as Model<any>, label: 'Revision History' },
  users: { model: UserModel as Model<any>, label: 'Users' },
};

export const KNOWN_ENTITIES = Object.keys(ENTITY_MAP);

export class EntitiesService implements IEntitiesService {
  async listEntities(): Promise<EntityMeta[]> {
    return Promise.all(
      Object.entries(ENTITY_MAP).map(async ([name, { model, label }]) => ({
        name,
        label,
        count: await model.countDocuments(),
      })),
    );
  }

  async queryEntity(entityName: string, options: QueryOptions): Promise<EntityPage> {
    const entry = ENTITY_MAP[entityName];
    if (!entry) throw new Error(`Unknown entity: ${entityName}`);

    const { model } = entry;
    const {
      page,
      pageSize: rawPageSize,
      search,
      sortField,
      sortDir,
      filterField,
      filterOp,
      filterValue,
    } = options;

    const pageSize = Math.min(rawPageSize, MAX_PAGE_SIZE);

    // ── Build Mongo filter ──────────────────────────────────────────────────────
    const filter: Record<string, unknown> = {};

    if (filterField && filterValue !== undefined && filterValue !== '') {
      filter[filterField] = buildFieldFilter(filterOp ?? 'eq', filterValue);
    }

    if (search) {
      const stringPaths = collectStringPaths(model);
      if (stringPaths.length > 0) {
        const searchConditions = stringPaths.map((p) => ({
          [p]: { $regex: escapeRegex(search), $options: 'i' },
        }));
        if (filter['$or']) {
          // Combine with existing $or via $and
          filter['$and'] = [{ $or: filter['$or'] }, { $or: searchConditions }];
          delete filter['$or'];
        } else {
          filter['$or'] = searchConditions;
        }
      }
    }

    // ── Sort ────────────────────────────────────────────────────────────────────
    const sort: Record<string, 1 | -1> = sortField
      ? { [sortField]: sortDir === 'desc' ? -1 : 1 }
      : { _id: -1 };

    const skip = (page - 1) * pageSize;

    // ── Query ───────────────────────────────────────────────────────────────────
    const [docs, total] = await Promise.all([
      model.find(filter).sort(sort).skip(skip).limit(pageSize).lean(),
      model.countDocuments(filter),
    ]);

    const cleaned = (docs as Record<string, unknown>[]).map(cleanDoc);
    const fields = inferFields(cleaned);

    return { data: cleaned, total, page, pageSize, fields };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildFieldFilter(op: FilterOp, value: string): unknown {
  switch (op) {
    case 'contains': return { $regex: escapeRegex(value), $options: 'i' };
    case 'gt':       return { $gt: value };
    case 'lt':       return { $lt: value };
    default:         return value; // 'eq'
  }
}

function collectStringPaths(model: Model<any>): string[] {
  const paths: string[] = [];
  model.schema.eachPath((path, schemaType) => {
    if ((schemaType as any).instance === 'String' && !EXCLUDED_KEYS.has(path)) {
      paths.push(path);
    }
  });
  return paths;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanDoc(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (!EXCLUDED_KEYS.has(k)) out[k] = v;
  }
  return out;
}

function inferFields(docs: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  for (const doc of docs) {
    for (const key of Object.keys(doc)) {
      seen.add(key);
    }
  }
  return Array.from(seen);
}
