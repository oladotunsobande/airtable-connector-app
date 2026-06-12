type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  message: string;
  context?: string;
  [key: string]: unknown;
}

type LogListener = (entry: LogEntry) => void;
const listeners = new Set<LogListener>();
export function addLogListener(fn: LogListener): void { listeners.add(fn); }
export function removeLogListener(fn: LogListener): void { listeners.delete(fn); }

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function getCurrentLevel(): LogLevel {
  return process.env['NODE_ENV'] === 'production' ? 'info' : 'debug';
}

// ── Pretty formatter (development) ────────────────────────────────────────────

const R = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info:  '\x1b[36m',
  warn:  '\x1b[33m',
  error: '\x1b[31m',
};

function formatPretty(entry: LogEntry): string {
  const { level, message, context, stack, ...rest } = entry;

  const ts = `${DIM}${new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z')}${R}`;
  const col = LEVEL_COLOR[level];
  const lvl = `${col}${BOLD}[${level.toUpperCase().padEnd(5)}]${R}`;
  const ctx = context ? ` ${DIM}${context}${R}` : '';

  const metaEntries = Object.entries(rest).filter(([, v]) => v !== undefined);
  const meta = metaEntries.length
    ? '  ' + DIM + metaEntries.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join('  ') + R
    : '';

  const line = `${ts} ${lvl}${ctx}  ${message}${meta}`;

  if (typeof stack === 'string') {
    const stackLines = stack.split('\n').map(l => `  ${col}${l}${R}`).join('\n');
    return `${line}\n${stackLines}`;
  }

  return line;
}

// ── JSON formatter (production) ───────────────────────────────────────────────

function formatJson(entry: LogEntry): string {
  return JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
}

// ── Core ──────────────────────────────────────────────────────────────────────

function log(entry: LogEntry): void {
  if (LEVELS[entry.level] < LEVELS[getCurrentLevel()]) return;

  const isProd = process.env['NODE_ENV'] === 'production';
  const output = isProd ? formatJson(entry) : formatPretty(entry);
  const stream = entry.level === 'error' || entry.level === 'warn' ? process.stderr : process.stdout;
  stream.write(output + '\n');
  for (const fn of listeners) fn(entry);
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(context: string): Logger;
}

function createLogger(context?: string): Logger {
  const base = (level: LogLevel, message: string, meta?: Record<string, unknown>) =>
    log({ level, message, ...(context ? { context } : {}), ...meta });

  return {
    debug: (msg, meta) => base('debug', msg, meta),
    info:  (msg, meta) => base('info',  msg, meta),
    warn:  (msg, meta) => base('warn',  msg, meta),
    error: (msg, meta) => base('error', msg, meta),
    child: (ctx) => createLogger(context ? `${context}:${ctx}` : ctx),
  };
}

export const logger: Logger = createLogger();
