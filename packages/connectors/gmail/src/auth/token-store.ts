import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Gmail OAuth2 token data */
export interface GmailTokenData {
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  expiry_date: number;
}

const TOKEN_FILE_MODE = 0o600;
const TOKEN_DIR_MODE = 0o700;

export class GmailTokenStore {
  private tokenPath: string;

  constructor(tokenPath: string) {
    this.tokenPath = tokenPath;
  }

  /** Load tokens from file */
  load(): GmailTokenData | null {
    if (!existsSync(this.tokenPath)) return null;
    try {
      const data = readFileSync(this.tokenPath, "utf8");
      return JSON.parse(data) as GmailTokenData;
    } catch {
      return null;
    }
  }

  /** Save tokens to file */
  save(tokens: GmailTokenData): void {
    const dir = dirname(this.tokenPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: TOKEN_DIR_MODE });
    }
    writeFileSync(this.tokenPath, JSON.stringify(tokens, null, 2), { mode: TOKEN_FILE_MODE });
  }

  /** Check if tokens are expired (with 1 min buffer) */
  isExpired(tokens: GmailTokenData): boolean {
    return Date.now() >= tokens.expiry_date - 60_000;
  }
}

/** Create an OAuth2 client for Gmail */
export function createOAuth2Client(config: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}) {
  const { OAuth2Client } = require("google-auth-library");
  return new OAuth2Client(
    config.clientId,
    config.clientSecret,
    config.redirectUri
  );
}

/** Generate OAuth2 authorization URL */
export function generateAuthUrl(
  oauth2Client: ReturnType<typeof createOAuth2Client>,
  scopes: string[]
): string {
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: scopes,
    prompt: "consent",
  });
}

/** Exchange authorization code for tokens */
export async function exchangeCodeForTokens(
  oauth2Client: ReturnType<typeof createOAuth2Client>,
  code: string
): Promise<GmailTokenData> {
  const { tokens } = await oauth2Client.getToken(code);

  const tokenData: GmailTokenData = {
    access_token: tokens.access_token!,
    refresh_token: tokens.refresh_token!,
    scope: tokens.scope || DEFAULT_SCOPES.join(" "),
    token_type: tokens.token_type || "Bearer",
    expiry_date: tokens.expiry_date!,
  };

  return tokenData;
}

/** Refresh access token using refresh token */
export async function refreshAccessToken(
  oauth2Client: ReturnType<typeof createOAuth2Client>,
  refreshToken: string
): Promise<GmailTokenData> {
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await oauth2Client.refreshAccessToken();

  const tokenData: GmailTokenData = {
    access_token: credentials.access_token!,
    refresh_token: credentials.refresh_token || refreshToken,
    scope: credentials.scope || DEFAULT_SCOPES.join(" "),
    token_type: credentials.token_type || "Bearer",
    expiry_date: credentials.expiry_date!,
  };

  return tokenData;
}

/** Get a valid access token, refreshing if needed */
export async function getValidAccessToken(
  tokenStore: GmailTokenStore,
  oauth2Client: ReturnType<typeof createOAuth2Client>
): Promise<string> {
  const tokens = tokenStore.load();
  if (!tokens) {
    throw new Error("No tokens found. Run OAuth flow first.");
  }

  if (tokenStore.isExpired(tokens)) {
    if (!tokens.refresh_token) {
      throw new Error("No refresh token available. Re-run OAuth flow.");
    }
    const newTokens = await refreshAccessToken(oauth2Client, tokens.refresh_token);
    tokenStore.save(newTokens);
    return newTokens.access_token;
  }

  return tokens.access_token;
}

const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
];