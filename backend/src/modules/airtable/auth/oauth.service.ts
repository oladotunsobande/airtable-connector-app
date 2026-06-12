import crypto from 'node:crypto';
import type { AppConfig } from '../../../config/index.js';
import type { IHttpClient } from '../../../infrastructure/http/http-client.interface.js';
import { OAuthError } from '../../../core/errors/index.js';
import type {
  IOAuthService,
  AuthorizationUrlResult,
  TokenSet,
} from './oauth.service.interface.js';

const AIRTABLE_AUTH_URL = 'https://airtable.com/oauth2/v1/authorize';
const AIRTABLE_TOKEN_URL = 'https://airtable.com/oauth2/v1/token';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function generateCodeVerifier(): string {
  return base64url(crypto.randomBytes(32));
}

function generateCodeChallenge(verifier: string): string {
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}

function generateState(): string {
  return base64url(crypto.randomBytes(16));
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

export class OAuthService implements IOAuthService {
  constructor(
    private readonly config: AppConfig,
    private readonly http: IHttpClient,
  ) {}

  buildAuthorizationUrl(): AuthorizationUrlResult {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = generateState();

    const params = new URLSearchParams({
      client_id: this.config.airtable.clientId,
      redirect_uri: this.config.airtable.redirectUri,
      response_type: 'code',
      scope: this.config.airtable.scopes.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return {
      url: `${AIRTABLE_AUTH_URL}?${params.toString()}`,
      codeVerifier,
      state,
    };
  }

  async exchangeCode(
    code: string,
    codeVerifier: string,
    state: string,
    receivedState: string,
  ): Promise<TokenSet> {
    if (state !== receivedState) {
      throw new OAuthError('OAuth state mismatch — possible CSRF attack');
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.config.airtable.clientId,
      redirect_uri: this.config.airtable.redirectUri,
      code_verifier: codeVerifier,
    });

    const response = await this.postTokenRequest(body);
    return this.toTokenSet(response);
  }

  async refreshAccessToken(refreshToken: string): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.config.airtable.clientId,
    });

    const response = await this.postTokenRequest(body);
    return this.toTokenSet(response);
  }

  private async postTokenRequest(body: URLSearchParams): Promise<TokenResponse> {
    // Airtable requires HTTP Basic auth with client_id:client_secret for the token endpoint.
    const credentials = Buffer.from(
      `${this.config.airtable.clientId}:${this.config.airtable.clientSecret}`,
    ).toString('base64');

    try {
      return await this.http.post<TokenResponse>(AIRTABLE_TOKEN_URL, body.toString(), {
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });
    } catch (err) {
      throw new OAuthError(
        'Failed to obtain tokens from Airtable',
        err instanceof Error ? err.message : err,
      );
    }
  }

  private toTokenSet(response: TokenResponse): TokenSet {
    return {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      expiresAt: new Date(Date.now() + response.expires_in * 1000),
      scope: response.scope,
      tokenType: response.token_type,
    };
  }
}
