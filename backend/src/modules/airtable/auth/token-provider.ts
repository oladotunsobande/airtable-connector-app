import type { Logger } from '../../../core/logger/index.js';
import { OAuthError } from '../../../core/errors/index.js';
import type { ITokenProvider } from './token-provider.interface.js';
import type { IOAuthService } from './oauth.service.interface.js';
import type { ITokenRepository } from './token.repository.interface.js';

/** Seconds before expiry at which we proactively refresh the access token. */
const REFRESH_BUFFER_SECONDS = 60;

export class TokenProvider implements ITokenProvider {
  constructor(
    private readonly oauthService: IOAuthService,
    private readonly tokenRepository: ITokenRepository,
    private readonly log: Logger,
  ) {}

  async getAccessToken(): Promise<string> {
    const tokenSet = await this.tokenRepository.find();

    if (!tokenSet) {
      throw new OAuthError(
        'No OAuth token found. Complete the OAuth flow at /auth/airtable/start first.',
      );
    }

    const expiresInMs = tokenSet.expiresAt.getTime() - Date.now();
    const bufferMs = REFRESH_BUFFER_SECONDS * 1000;

    if (expiresInMs > bufferMs) {
      return tokenSet.accessToken;
    }

    // Token is expired or about to expire — refresh silently.
    this.log.info('Access token expiring — refreshing', {
      expiresAt: tokenSet.expiresAt.toISOString(),
      expiresInMs,
    });

    try {
      const refreshed = await this.oauthService.refreshAccessToken(tokenSet.refreshToken);
      await this.tokenRepository.save(refreshed);
      this.log.info('Access token refreshed', { expiresAt: refreshed.expiresAt.toISOString() });
      return refreshed.accessToken;
    } catch (err) {
      this.log.error('Failed to refresh access token', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async isConnected(): Promise<boolean> {
    const tokenSet = await this.tokenRepository.find();
    return tokenSet !== null;
  }
}
