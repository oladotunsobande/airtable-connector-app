type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  message: string;
  context?: string;
  [key: string]: unknown;
}

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function getCurrentLevel(): LogLevel {
  const env = process.env['NODE_ENV'];
  return env === 'production' ? 'info' : 'debug';
}

function log(entry: LogEntry): void {
  const minLevel = getCurrentLevel();
  if (LEVELS[entry.level] < LEVELS[minLevel]) return;

  const output = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...entry,
  });

  if (entry.level === 'error' || entry.level === 'warn') {
    process.stderr.write(output + '\n');
  } else {
    process.stdout.write(output + '\n');
  }
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
    info: (msg, meta) => base('info', msg, meta),
    warn: (msg, meta) => base('warn', msg, meta),
    error: (msg, meta) => base('error', msg, meta),
    child: (ctx) => createLogger(context ? `${context}:${ctx}` : ctx),
  };
}

export const logger: Logger = createLogger();
