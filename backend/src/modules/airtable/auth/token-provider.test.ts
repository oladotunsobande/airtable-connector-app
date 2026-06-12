import { describe, it, expect, vi } from 'vitest';
import { TokenProvider } from './token-provider.js';
import { OAuthError } from '../../../core/errors/index.js';
import type { IOAuthService, TokenSet } from './oauth.service.interface.js';
import type { ITokenRepository } from './token.repository.interface.js';
import type { Logger } from '../../../core/logger/index.js';

// REFRESH_BUFFER_SECONDS is 60 in the implementation
const BUFFER_MS = 60_000;

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

function makeTokenSet(expiresAt: Date, accessToken = 'stored-access'): TokenSet {
  return {
    accessToken,
    refreshToken: 'stored-refresh',
    expiresAt,
    scope: 'data.records:read',
    tokenType: 'Bearer',
  };
}

function makeRepo(token: TokenSet | null): ITokenRepository {
  return {
    find: vi.fn().mockResolvedValue(token),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function makeOAuth(refreshResult?: TokenSet): IOAuthService {
  return {
    buildAuthorizationUrl: vi.fn(),
    exchangeCode: vi.fn(),
    refreshAccessToken: refreshResult
      ? vi.fn().mockResolvedValue(refreshResult)
      : vi.fn(),
  };
}

describe('TokenProvider', () => {
  describe('getAccessToken', () => {
    it('throws OAuthError when no token is stored', async () => {
      const provider = new TokenProvider(makeOAuth(), makeRepo(null), makeLogger());

      await expect(provider.getAccessToken()).rejects.toBeInstanceOf(OAuthError);
    });

    it('returns the stored accessToken when expiry is far in the future', async () => {
      const farFuture = new Date(Date.now() + 2 * BUFFER_MS);
      const token = makeTokenSet(farFuture, 'valid-access-token');
      const oauth = makeOAuth();
      const provider = new TokenProvider(oauth, makeRepo(token), makeLogger());

      const result = await provider.getAccessToken();

      expect(result).toBe('valid-access-token');
      expect(oauth.refreshAccessToken).not.toHaveBeenCalled();
    });

    it('refreshes token when expiry is inside the 60-second buffer', async () => {
      const nearExpiry = new Date(Date.now() + 30_000); // 30s — inside 60s buffer
      const old = makeTokenSet(nearExpiry, 'old-access');
      const fresh = makeTokenSet(new Date(Date.now() + 3_600_000), 'refreshed-access');
      const repo = makeRepo(old);
      const oauth = makeOAuth(fresh);
      const provider = new TokenProvider(oauth, repo, makeLogger());

      const result = await provider.getAccessToken();

      expect(result).toBe('refreshed-access');
      expect(oauth.refreshAccessToken).toHaveBeenCalledWith(old.refreshToken);
      expect(repo.save).toHaveBeenCalledWith(fresh);
    });

    it('refreshes token when access token is already expired', async () => {
      const pastExpiry = new Date(Date.now() - 1_000);
      const old = makeTokenSet(pastExpiry, 'expired-access');
      const fresh = makeTokenSet(new Date(Date.now() + 3_600_000), 'new-access');
      const oauth = makeOAuth(fresh);
      const provider = new TokenProvider(oauth, makeRepo(old), makeLogger());

      const result = await provider.getAccessToken();

      expect(result).toBe('new-access');
      expect(oauth.refreshAccessToken).toHaveBeenCalledOnce();
    });

    it('re-throws the refresh error when refresh fails', async () => {
      const nearExpiry = new Date(Date.now() + 10_000);
      const old = makeTokenSet(nearExpiry);
      const refreshErr = new OAuthError('upstream refresh failed');
      const oauth: IOAuthService = {
        buildAuthorizationUrl: vi.fn(),
        exchangeCode: vi.fn(),
        refreshAccessToken: vi.fn().mockRejectedValue(refreshErr),
      };
      const provider = new TokenProvider(oauth, makeRepo(old), makeLogger());

      await expect(provider.getAccessToken()).rejects.toBe(refreshErr);
    });

    it('logs a warning before attempting refresh', async () => {
      const nearExpiry = new Date(Date.now() + 10_000);
      const old = makeTokenSet(nearExpiry);
      const fresh = makeTokenSet(new Date(Date.now() + 3_600_000));
      const oauth = makeOAuth(fresh);
      const log = makeLogger();
      const provider = new TokenProvider(oauth, makeRepo(old), log);

      await provider.getAccessToken();

      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining('expiring'),
        expect.anything(),
      );
    });
  });

  describe('isConnected', () => {
    it('returns false when no token is stored', async () => {
      const provider = new TokenProvider(makeOAuth(), makeRepo(null), makeLogger());
      expect(await provider.isConnected()).toBe(false);
    });

    it('returns true when a token exists', async () => {
      const token = makeTokenSet(new Date(Date.now() + 3_600_000));
      const provider = new TokenProvider(makeOAuth(), makeRepo(token), makeLogger());
      expect(await provider.isConnected()).toBe(true);
    });
  });
});
