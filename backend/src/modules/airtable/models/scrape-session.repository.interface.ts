export type SessionState = 'active' | 'awaiting_mfa' | 'expired' | 'invalid';

export interface SerializedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
}

export interface HarvestedTokens {
  secretSocketId: string;
}

export interface ScrapeSessionDocument {
  sessionId: string;
  cookies: SerializedCookie[];
  harvestedTokens: HarvestedTokens | null;
  state: SessionState;
  validatedAt: Date | null;
  expiresAt: Date | null;
}

export interface IScrapeSessionRepository {
  save(session: ScrapeSessionDocument): Promise<ScrapeSessionDocument>;
  findActive(): Promise<ScrapeSessionDocument | null>;
  updateState(sessionId: string, state: SessionState, validatedAt?: Date): Promise<void>;
  updateTokens(sessionId: string, cookies: SerializedCookie[], tokens: HarvestedTokens): Promise<void>;
  delete(sessionId: string): Promise<void>;
}
