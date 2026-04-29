/**
 * http — small tRPC-over-HTTP client for the mesh-fixture CLI.
 *
 * Two wire shapes in play across the mesh:
 *
 *   a) plain JSON (iam-api, programs-api, scheduling-api):
 *      - POST /trpc/<path>  body = <input>
 *      - GET  /trpc/<path>?input=<url-encoded JSON>
 *      - response envelope = { result: { data: T } }
 *
 *   b) superjson (ads-adm-api — @saga-ed/soa-trpc-base ships with the
 *      superjson transformer bolted on):
 *      - POST body = { json: <input> }  (meta elided when no Dates/Maps)
 *      - GET  input param = JSON.stringify({ json: <input> })
 *      - response envelope = { result: { data: { json: T, meta? } } }
 *
 * Caller picks the transformer via `transformer: 'none' | 'superjson'` on
 * TrpcClient construction. Default is 'none' (matches historical behavior).
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

export type TrpcTransformer = 'none' | 'superjson';

export interface TrpcClientOptions {
  baseUrl: string;
  /** Optional session cookie to send on every request. */
  cookie?: string;
  /** Optional extra headers (org id, trace id, etc.). */
  headers?: Record<string, string>;
  /**
   * Wire transformer the target server uses. 'none' sends plain JSON
   * (iam-api, programs-api, scheduling-api). 'superjson' wraps every
   * input/output in `{ json: ..., meta? }` (ads-adm-api via
   * @saga-ed/soa-trpc-base).
   */
  transformer?: TrpcTransformer;
}

export class TrpcClient {
  private readonly transformer: TrpcTransformer;

  constructor(private readonly opts: TrpcClientOptions) {
    this.transformer = opts.transformer ?? 'none';
  }

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
      url.searchParams.set('input', JSON.stringify(this.wrapInput(input)));
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
      body: JSON.stringify(this.wrapInput(input ?? {})),
    });
    return this.unwrap<T>(procedure, res);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { ...(this.opts.headers ?? {}) };
    if (this.opts.cookie) h['Cookie'] = this.opts.cookie;
    return h;
  }

  private wrapInput(input: unknown): unknown {
    // superjson hosts want `{ json: <payload> }`. Dates / Maps / BigInts
    // would also need a `meta` field — we don't pass those as input, so
    // omit meta.
    return this.transformer === 'superjson' ? { json: input } : input;
  }

  private unwrapData<T>(data: unknown): T {
    // superjson response payload is `{ json: T, meta? }`. We ignore meta
    // since none of the fields we care about are superjson-encoded
    // primitives (SnapshotMetadata dates come back as ISO strings from
    // the Prisma Json columns — but top-level createdAt / lastUpdated
    // ARE Date-typed in the Prisma schema, so superjson will tag them
    // in meta. If a caller needs the actual Date, they can re-parse.)
    if (this.transformer === 'superjson' && data && typeof data === 'object' && 'json' in data) {
      return (data as { json: T }).json;
    }
    return data as T;
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
    const envelope = parsed as { result?: { data?: unknown } };
    if (envelope.result && 'data' in envelope.result) {
      return this.unwrapData<T>(envelope.result.data);
    }
    // Some endpoints (older format, or error-path 2xx) may not use the
    // envelope — return the raw body.
    return parsed as T;
  }

  private extractTrpcError(body: unknown): TrpcError | null {
    if (typeof body !== 'object' || body === null) return null;
    // superjson error envelope: { error: { json: {message, code, data} } }
    // plain  error envelope: { error: {message, code, data} }
    const root = body as { error?: Record<string, unknown> };
    if (!root.error) return null;
    const source =
      this.transformer === 'superjson' && root.error['json']
        ? (root.error['json'] as Record<string, unknown>)
        : root.error;
    return {
      message: (source['message'] as string | undefined) ?? 'unknown',
      code: (source['code'] as number | undefined) ?? -1,
      data: source['data'] as TrpcError['data'],
    };
  }
}

/** Parse Set-Cookie response header and extract `name=value` for `cookieName`. */
export function extractCookie(setCookie: string, cookieName: string): string | null {
  // Set-Cookie may be comma-separated if multiple cookies set; regex handles both.
  const re = new RegExp(`(?:^|[,;\\s])${cookieName}=([^;]+)`);
  const m = re.exec(setCookie);
  return m?.[1] ?? null;
}
