import type { TokenSet } from './oauth.service.interface.js';

export interface ITokenRepository {
  save(tokenSet: TokenSet): Promise<void>;
  find(): Promise<TokenSet | null>;
  delete(): Promise<void>;
}
