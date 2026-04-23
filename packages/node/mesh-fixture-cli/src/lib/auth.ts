/**
 * auth — dev-login flow against iam-api.
 *
 * iam-api with AUTH_AUTHENABLED=false exposes `auth.devLogin` which takes
 * { email } and returns a session cookie (`iam_session` or legacy
 * `iam_dev_session`). We issue a single login per CLI invocation and reuse
 * the cookie across all downstream tRPC calls.
 *
 * CLI convention: every create-* command takes a required `--as <email>`
 * flag (or defaults to the "fixture admin" env var). The cookie is an
 * implementation detail — callers pass emails, not cookies.
 */

import { TrpcClient, extractCookie } from './http.js';

export interface DevLoginResult {
  userId: string;
  cookie: string;
}

/**
 * Log in as `email` against iam-api. Returns the session cookie and the
 * authenticated user's id. Throws on 4xx/5xx.
 */
export async function devLogin(iamUrl: string, email: string): Promise<DevLoginResult> {
  // We don't use TrpcClient here because we need direct access to the
  // Set-Cookie header. TrpcClient's .mutation() would strip that.
  const res = await fetch(new URL('/trpc/auth.devLogin', iamUrl).toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const rawBody = await res.text();
  if (!res.ok) {
    throw new Error(`auth.devLogin failed for ${email}: HTTP ${res.status} — ${rawBody}`);
  }
  const setCookie = res.headers.get('set-cookie') ?? '';
  const token =
    extractCookie(setCookie, 'iam_session') ??
    extractCookie(setCookie, 'iam_dev_session');
  if (!token) {
    throw new Error(
      `auth.devLogin 2xx but no iam session cookie in Set-Cookie: ${setCookie}`,
    );
  }
  let userId: string;
  try {
    const parsed = JSON.parse(rawBody) as {
      result?: { data?: { userId?: string } };
    };
    userId = parsed.result?.data?.userId ?? email;
  } catch {
    userId = email;
  }
  return { cookie: `iam_session=${token}`, userId };
}

/**
 * Convenience: log in + return a ready-to-use TrpcClient against the given
 * service base URL. Cookie is attached; additional headers can be chained
 * via client.withHeader().
 */
export async function loggedInClient(
  iamUrl: string,
  serviceUrl: string,
  email: string,
): Promise<{ client: TrpcClient; userId: string; cookie: string }> {
  const { cookie, userId } = await devLogin(iamUrl, email);
  const client = new TrpcClient({ baseUrl: serviceUrl, cookie });
  return { client, userId, cookie };
}
