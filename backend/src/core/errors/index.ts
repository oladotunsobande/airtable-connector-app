export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'CONFIGURATION_ERROR', 500, details);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super(
      id ? `${resource} '${id}' not found` : `${resource} not found`,
      'NOT_FOUND',
      404,
    );
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 'UNAUTHORIZED', 401);
  }
}

export class RateLimitError extends AppError {
  constructor(public readonly retryAfterMs: number) {
    super(`Rate limit exceeded. Retry after ${retryAfterMs}ms`, 'RATE_LIMIT_EXCEEDED', 429);
  }
}

export class HttpClientError extends AppError {
  constructor(
    message: string,
    public readonly httpStatus: number,
    details?: unknown,
  ) {
    super(message, 'HTTP_CLIENT_ERROR', httpStatus, details);
  }
}

export class ScrapingError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'SCRAPING_ERROR', 500, details);
  }
}

export class SessionExpiredError extends AppError {
  constructor() {
    super('Airtable scraping session has expired', 'SESSION_EXPIRED', 401);
  }
}

export class OAuthError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'OAUTH_ERROR', 401, details);
  }
}
