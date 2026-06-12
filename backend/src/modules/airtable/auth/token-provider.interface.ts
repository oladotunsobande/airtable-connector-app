export interface ITokenProvider {
  /** Returns a valid access token, refreshing if necessary. */
  getAccessToken(): Promise<string>;
  isConnected(): Promise<boolean>;
}
