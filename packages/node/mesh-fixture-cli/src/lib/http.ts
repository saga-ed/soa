/**
 * http — small tRPC-over-HTTP client for the mesh-fixture CLI.
 *
 * tRPC v11 wire format at the endpoints we care about (iam-api, programs-api):
 *   - POST /trpc/<path>  with body = input (top-level JSON, NOT wrapped in `{ json: {...} }`)
 *   - GET  /trpc/<path>?input=<encoded JSON>  for queries
 *
 * Responses are `{ result: { data: T } }` on success, `{ error: { ... } }`
 * on failure. We unwrap both cases and throw a typed error on failure.
 *
 * Auth: session cookie set by /trpc/auth.devLogin. Callers pass the cookie
 * string into the client constructor; the cookie flows through every
 * request's Cookie header.
 */

export interface TrpcError {
  message: string;
  code: number;
  data?: { code?: string; httpStatus?: number; path?: string };
}

export class TrpcCallError extends Error {
  constructor(
    readonly procedure: string,
    readonly status: number,
    readonly trpcError: TrpcError | null,
    readonly rawBody: string,
  ) {
    const msg =
      trpcError?.message ??
      `${procedure} failed: HTTP ${status} (no tRPC error envelope)`;
    super(`tRPC ${procedure}: ${msg}`);
    this.name = 'TrpcCallError';
  }
}

export interface TrpcClientOptions {
  baseUrl: string;
  /** Optional session cookie to send on every request. */
  cookie?: string;
  /** Optional extra headers (org id, trace id, etc.). */
  headers?: Record<string, string>;
}

export class TrpcClient {
  constructor(private readonly opts: TrpcClientOptions) {}

  withCookie(cookie: string): TrpcClient {
    return new TrpcClient({ ...this.opts, cookie });
  }

  withHeader(name: string, value: string): TrpcClient {
    return new TrpcClient({
      ...this.opts,
      headers: { ...this.opts.headers, [name]: value },
    });
  }

  async query<T = unknown>(procedure: string, input?: unknown): Promise<T> {
    const url = new URL(`/trpc/${procedure}`, this.opts.baseUrl);
    if (input !== undefined) {
      url.searchParams.set('input', JSON.stringify(input));
    }
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: this.headers(),
    });
    return this.unwrap<T>(procedure, res);
  }

  async mutation<T = unknown>(procedure: string, input?: unknown): Promise<T> {
    const url = new URL(`/trpc/${procedure}`, this.opts.baseUrl);
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...this.headers(),
      },
      body: JSON.stringify(input ?? {}),
    });
    return this.unwrap<T>(procedure, res);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { ...(this.opts.headers ?? {}) };
    if (this.opts.cookie) h['Cookie'] = this.opts.cookie;
    return h;
  }

  private async unwrap<T>(procedure: string, res: Response): Promise<T> {
    const rawBody = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new TrpcCallError(procedure, res.status, null, rawBody);
    }

    if (!res.ok) {
      const err = this.extractTrpcError(parsed);
      throw new TrpcCallError(procedure, res.status, err, rawBody);
    }

    // Successful tRPC v11 envelope: { result: { data: T } }
    const envelope = parsed as { result?: { data?: T } };
    if (envelope.result && 'data' in envelope.result) {
      return envelope.result.data as T;
    }
    // Some endpoints (older format, or error-path 2xx) may not use the
    // envelope — return the raw body.
    return parsed as T;
  }

  private extractTrpcError(body: unknown): TrpcError | null {
    if (typeof body !== 'object' || body === null) return null;
    const b = body as { error?: { message?: string; code?: number; data?: TrpcError['data']; json?: unknown } };
    if (b.error) {
      return {
        message: b.error.message ?? 'unknown',
        code: b.error.code ?? -1,
        data: b.error.data,
      };
    }
    return null;
  }
}

/** Parse Set-Cookie response header and extract `name=value` for `cookieName`. */
export function extractCookie(setCookie: string, cookieName: string): string | null {
  // Set-Cookie may be comma-separated if multiple cookies set; regex handles both.
  const re = new RegExp(`(?:^|[,;\\s])${cookieName}=([^;]+)`);
  const m = re.exec(setCookie);
  return m?.[1] ?? null;
}
