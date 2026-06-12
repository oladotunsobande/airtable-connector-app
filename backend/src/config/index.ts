import 'dotenv/config';

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    // In non-production environments allow the app to boot without credentials
    // so the scaffold can be verified before secrets are configured.
    const env = process.env['NODE_ENV'] ?? 'development';
    if (env !== 'production') {
      return `__MISSING_${key}__`;
    }
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function optionalInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (isNaN(n)) throw new Error(`Environment variable ${key} must be an integer`);
  return n;
}

export interface AppConfig {
  nodeEnv: string;
  port: number;
  corsOrigins: string[];
  mongo: {
    uri: string;
  };
  redis: {
    host: string;
    port: number;
  };
  airtable: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    scopes: string[];
    loginEmail: string;
    loginPassword: string;
    webUrl: string;
    apiBaseUrl: string;
    rps: number;
  };
  encryption: {
    key: string;
  };
  pipeline: {
    maxBasesPerRun: number;
  };
}

export function loadConfig(): AppConfig {
  return {
    nodeEnv: optional('NODE_ENV', 'development'),
    port: optionalInt('PORT', 3000),
    corsOrigins: optional('CORS_ORIGINS', 'http://localhost:4200').split(',').map(s => s.trim()).filter(Boolean),
    mongo: {
      uri: optional('MONGO_URI', 'mongodb://localhost:27017/airtable_connector'),
    },
    redis: {
      host: optional('REDIS_HOST', 'localhost'),
      port: optionalInt('REDIS_PORT', 6379),
    },
    airtable: {
      clientId: required('AIRTABLE_CLIENT_ID'),
      clientSecret: required('AIRTABLE_CLIENT_SECRET'),
      redirectUri: required('AIRTABLE_REDIRECT_URI'),
      scopes: optional('AIRTABLE_SCOPES', 'data.records:read schema.bases:read').split(' '),
      loginEmail: required('AIRTABLE_LOGIN_EMAIL'),
      loginPassword: required('AIRTABLE_LOGIN_PASSWORD'),
      webUrl: optional('AIRTABLE_WEB_URL', 'https://airtable.com'),
      apiBaseUrl: 'https://api.airtable.com/v0',
      rps: optionalInt('AIRTABLE_RPS', 5),
    },
    encryption: {
      key: required('ENCRYPTION_KEY'),
    },
    pipeline: {
      maxBasesPerRun: optionalInt('MAX_BASES_PER_RUN', 5),
    },
  };
}
