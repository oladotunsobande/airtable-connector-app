export interface AuthorizationUrlResult {
  url: string;
  codeVerifier: string;
  state: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scope: string;
  tokenType: string;
}

export interface IOAuthService {
  buildAuthorizationUrl(): AuthorizationUrlResult;
  exchangeCode(code: string, codeVerifier: string, state: string, receivedState: string): Promise<TokenSet>;
  refreshAccessToken(refreshToken: string): Promise<TokenSet>;
}
