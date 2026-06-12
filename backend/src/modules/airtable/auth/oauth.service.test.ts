import { describe, it, expect, vi } from 'vitest';
import { OAuthService } from './oauth.service.js';
import { OAuthError } from '../../../core/errors/index.js';
import type { IHttpClient } from '../../../infrastructure/http/http-client.interface.js';

const mockConfig = {
  airtable: {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    redirectUri: 'http://localhost:3000/auth/callback',
    scopes: ['data.records:read', 'schema.bases:read'],
  },
} as const;

const tokenResponse = {
  access_token: 'acc-token-123',
  refresh_token: 'ref-token-456',
  expires_in: 3600,
  scope: 'data.records:read',
  token_type: 'Bearer',
};

function makeHttp(overrides: Partial<IHttpClient> = {}): IHttpClient {
  return {
    get: vi.fn(),
    post: vi.fn().mockResolvedValue(tokenResponse),
    put: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  };
}

describe('OAuthService', () => {
  describe('buildAuthorizationUrl', () => {
    it('returns a URL containing the client_id and code_challenge', () => {
      const svc = new OAuthService(mockConfig as never, makeHttp());
      const { url, codeVerifier, state } = svc.buildAuthorizationUrl();

      expect(url).toContain('client_id=test-client-id');
      expect(url).toContain('code_challenge=');
      expect(url).toContain('code_challenge_method=S256');
      expect(url).toContain('response_type=code');
      expect(codeVerifier).toBeTruthy();
      expect(state).toBeTruthy();
    });

    it('generates unique state and codeVerifier on each call', () => {
      const svc = new OAuthService(mockConfig as never, makeHttp());
      const a = svc.buildAuthorizationUrl();
      const b = svc.buildAuthorizationUrl();

      expect(a.state).not.toBe(b.state);
      expect(a.codeVerifier).not.toBe(b.codeVerifier);
    });

    it('includes all configured scopes space-separated', () => {
      const svc = new OAuthService(mockConfig as never, makeHttp());
      const { url } = svc.buildAuthorizationUrl();

      // URLSearchParams encodes spaces as '+'; use URL.searchParams to decode correctly
      const scope = new URL(url).searchParams.get('scope');
      expect(scope).toBe('data.records:read schema.bases:read');
    });
  });

  describe('exchangeCode', () => {
    it('throws OAuthError when received state does not match expected state', async () => {
      const svc = new OAuthService(mockConfig as never, makeHttp());

      await expect(
        svc.exchangeCode('auth-code', 'verifier', 'state-A', 'state-B'),
      ).rejects.toBeInstanceOf(OAuthError);
    });

    it('calls the token endpoint and returns a TokenSet on state match', async () => {
      const http = makeHttp();
      const svc = new OAuthService(mockConfig as never, http);

      const tokens = await svc.exchangeCode('auth-code', 'verifier', 'state-X', 'state-X');

      expect(tokens.accessToken).toBe('acc-token-123');
      expect(tokens.refreshToken).toBe('ref-token-456');
      expect(tokens.scope).toBe('data.records:read');
      expect(tokens.tokenType).toBe('Bearer');
      expect(tokens.expiresAt).toBeInstanceOf(Date);
      expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(http.post).toHaveBeenCalledOnce();
    });

    it('sends authorization_code grant type in POST body', async () => {
      const http = makeHttp();
      const svc = new OAuthService(mockConfig as never, http);

      await svc.exchangeCode('my-code', 'my-verifier', 'st', 'st');

      const [, body] = (http.post as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        string,
        unknown,
      ];
      expect(body).toContain('grant_type=authorization_code');
      expect(body).toContain('code=my-code');
      expect(body).toContain('code_verifier=my-verifier');
    });

    it('uses HTTP Basic auth with client_id:client_secret', async () => {
      const http = makeHttp();
      const svc = new OAuthService(mockConfig as never, http);

      await svc.exchangeCode('code', 'v', 's', 's');

      const [, , options] = (http.post as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        string,
        { headers: Record<string, string> },
      ];
      const expected = Buffer.from('test-client-id:test-client-secret').toString('base64');
      expect(options.headers['Authorization']).toBe(`Basic ${expected}`);
    });

    it('wraps http errors in OAuthError', async () => {
      const http = makeHttp({ post: vi.fn().mockRejectedValue(new Error('network timeout')) });
      const svc = new OAuthService(mockConfig as never, http);

      await expect(svc.exchangeCode('c', 'v', 's', 's')).rejects.toBeInstanceOf(OAuthError);
    });
  });

  describe('refreshAccessToken', () => {
    it('posts refresh_token grant and returns a new TokenSet', async () => {
      const http = makeHttp();
      const svc = new OAuthService(mockConfig as never, http);

      const tokens = await svc.refreshAccessToken('old-refresh-token');

      expect(tokens.accessToken).toBe('acc-token-123');
      expect(tokens.refreshToken).toBe('ref-token-456');
      expect(tokens.expiresAt).toBeInstanceOf(Date);
    });

    it('sends the refresh token in the POST body', async () => {
      const http = makeHttp();
      const svc = new OAuthService(mockConfig as never, http);

      await svc.refreshAccessToken('my-refresh-tok');

      const [, body] = (http.post as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        string,
        unknown,
      ];
      expect(body).toContain('grant_type=refresh_token');
      expect(body).toContain('refresh_token=my-refresh-tok');
    });

    it('wraps http errors in OAuthError', async () => {
      const http = makeHttp({ post: vi.fn().mockRejectedValue(new Error('401')) });
      const svc = new OAuthService(mockConfig as never, http);

      await expect(svc.refreshAccessToken('tok')).rejects.toBeInstanceOf(OAuthError);
    });

    it('sets expiresAt to approximately now + expires_in seconds', async () => {
      const http = makeHttp({
        post: vi.fn().mockResolvedValue({ ...tokenResponse, expires_in: 7200 }),
      });
      const svc = new OAuthService(mockConfig as never, http);

      const before = Date.now();
      const tokens = await svc.refreshAccessToken('tok');
      const after = Date.now();

      const expectedMin = before + 7200 * 1000 - 100;
      const expectedMax = after + 7200 * 1000 + 100;
      expect(tokens.expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMin);
      expect(tokens.expiresAt.getTime()).toBeLessThanOrEqual(expectedMax);
    });
  });
});
