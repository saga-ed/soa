import { channel } from 'node:diagnostics_channel';
import { errorMonitor } from 'node:events';
import type { ClientRequest, IncomingMessage, ServerResponse } from 'node:http';
import { diag, metrics, type Attributes, type Meter, type Span } from '@opentelemetry/api';

export interface HttpMetricRoute {
  /** Static route template; a whole :parameter segment matches one path segment. */
  path: string;
  methods: string[];
}
export interface HttpMetricPeer {
  service: string;
  /** Exact HTTP(S) origins, including non-default ports. Never emitted as labels. */
  origins: string[];
  routes: HttpMetricRoute[];
}

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const SERVICE = /^[a-z][a-z0-9-]{0,63}$/;
const ROUTE =
  /^\/(?:[A-Za-z0-9_.~-]+|:[A-Za-z][A-Za-z0-9_]*)(?:\/(?:[A-Za-z0-9_.~-]+|:[A-Za-z][A-Za-z0-9_]*))*\/?$/;
const OUTCOMES = ['success', 'http_error', 'transport_error', 'aborted'] as const;
type Outcome = (typeof OUTCOMES)[number];
interface Series {
  attributes: Attributes;
  attempts: number;
  completed: Map<string, number>;
}
interface Match {
  origin: string;
  method: string;
  path: string;
  segments: string[];
  series: Series;
}
interface UndiciRequest {
  origin: string;
  method: string;
  path: string;
}
interface UndiciMessage {
  request: UndiciRequest;
  response?: { statusCode: number };
  error?: { name?: string; code?: string };
}

/** Fail closed for telemetry only: invalid opt-in never interferes with application traffic. */
export function resolveHttpMetricPeers(
  value = process.env.SAGA_HTTP_METRIC_PEERS
): HttpMetricPeer[] | undefined {
  if (!value) return undefined;
  try {
    const peers: unknown = JSON.parse(value);
    if (!Array.isArray(peers) || peers.length < 1 || peers.length > 16) throw new Error('peers');
    const seen = new Set<string>();
    const tagPaths = new Map<string, string>();
    let routes = 0;
    for (const peer of peers) {
      if (
        !peer ||
        !SERVICE.test(peer.service) ||
        !Array.isArray(peer.origins) ||
        peer.origins.length < 1 ||
        peer.origins.length > 8 ||
        !Array.isArray(peer.routes) ||
        peer.routes.length < 1
      )
        throw new Error('peer');
      for (const origin of peer.origins) {
        const url = new URL(origin);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.origin !== origin ||
          url.username ||
          url.password
        )
          throw new Error('origin');
      }
      for (const route of peer.routes) {
        if (
          ++routes > 64 ||
          typeof route.path !== 'string' ||
          route.path.length > 160 ||
          (route.path !== '/' && !ROUTE.test(route.path)) ||
          !Array.isArray(route.methods) ||
          route.methods.length < 1 ||
          route.methods.length > METHODS.size ||
          route.methods.some(
            (method: unknown) => typeof method !== 'string' || !METHODS.has(method)
          )
        )
          throw new Error('route');
        for (const origin of peer.origins)
          for (const method of route.methods) {
            const tagKey = `${peer.service}|${method}|${route.path.toLowerCase()}`;
            if (tagPaths.has(tagKey) && tagPaths.get(tagKey) !== route.path)
              throw new Error('case collision');
            tagPaths.set(tagKey, route.path);
            const key = `${origin}|${method}|${route.path.replace(/:[A-Za-z][A-Za-z0-9_]*/g, ':parameter')}`;
            if (seen.has(key)) throw new Error('duplicate');
            seen.add(key);
          }
      }
    }
    return peers;
  } catch {
    diag.warn('[http-client-metrics] invalid SAGA_HTTP_METRIC_PEERS; path counters disabled');
    return undefined;
  }
}

/**
 * Physical HTTP attempt counters, independent of recording/sampling a span.
 * Observable monotonic totals produce explicit idle zeros after DELTA conversion.
 * Labels come only from the bounded configuration, never from request URLs/data.
 */
export function createHttpClientMetrics(
  service: string,
  peers: HttpMetricPeer[],
  meter: Meter = metrics.getMeter('saga.http.client', '1')
) {
  const attempts = meter.createObservableCounter('saga.http.client.attempts', {
    unit: '{request}',
    description:
      'Started physical HTTP attempts to configured peer routes; retries are separate attempts.',
  });
  const completed = meter.createObservableCounter('saga.http.client.requests', {
    unit: '{request}',
    description:
      'Terminal physical HTTP attempts, including HTTP and transport failures; not tRPC procedure invocations.',
  });
  const active = meter.createObservableGauge('saga.http.client.metrics.active', {
    description:
      'One while this process observes the configured HTTP peer route; exported even when idle.',
  });
  const series = new Map<string, Series>();
  const matches: Match[] = [];
  for (const peer of peers)
    for (const route of peer.routes)
      for (const method of route.methods) {
        const key = `${peer.service}|${method}|${route.path}`;
        let row = series.get(key);
        if (!row) {
          row = {
            attributes: {
              'source.service': service,
              'peer.service': peer.service,
              'http.method': method,
              'http.route': route.path,
            },
            attempts: 0,
            completed: new Map([['success|2xx', 0]]),
          };
          series.set(key, row);
        }
        for (const origin of peer.origins)
          matches.push({
            origin,
            method,
            path: route.path,
            segments: route.path.split('/'),
            series: row,
          });
      }
  // Prefer explicit routes over parameterized routes; aliases to one peer share a counter.
  matches.sort(
    (a, b) =>
      a.segments.filter(s => s.startsWith(':')).length -
      b.segments.filter(s => s.startsWith(':')).length
  );
  let healthy = true;
  const observe: Parameters<Meter['addBatchObservableCallback']>[0] = result => {
    for (const row of series.values()) {
      result.observe(attempts, row.attempts, row.attributes);
      result.observe(active, healthy ? 1 : 0, row.attributes);
      for (const [key, value] of row.completed) {
        const [outcome, status] = key.split('|');
        result.observe(completed, value, {
          ...row.attributes,
          outcome,
          'http.status_class': status,
        });
      }
    }
  };
  meter.addBatchObservableCallback(observe, [attempts, completed, active]);

  function begin(origin: string, method: string, path: string) {
    if (path.length > 4096) return;
    let url: URL;
    try {
      url = new URL(path, origin);
    } catch {
      return;
    }
    const segments = url.pathname.split('/');
    const match = matches.find(
      candidate =>
        candidate.origin === url.origin &&
        candidate.method === method &&
        candidate.segments.length === segments.length &&
        candidate.segments.every((segment, i) =>
          segment.startsWith(':') ? segments[i] !== '' : segment === segments[i]
        )
    );
    if (!match) return;
    match.series.attempts++;
    let finished = false;
    return (outcome: Outcome, status?: number) => {
      if (finished) return;
      finished = true;
      const statusClass =
        status && status >= 100 && status <= 599 ? `${Math.floor(status / 100)}xx` : 'none';
      const key = `${outcome}|${statusClass}`;
      match.series.completed.set(key, (match.series.completed.get(key) ?? 0) + 1);
    };
  }
  function outcome(status: number): Outcome {
    return status < 100 ? 'transport_error' : status >= 400 ? 'http_error' : 'success';
  }
  function aborted(error?: { name?: string; code?: string }): boolean {
    return (
      error?.name === 'AbortError' ||
      error?.code === 'ABORT_ERR' ||
      error?.code === 'UND_ERR_ABORTED'
    );
  }

  const undici = new WeakMap<
    UndiciRequest,
    { finish: NonNullable<ReturnType<typeof begin>>; status?: number }
  >();
  const subscriptions: [string, (message: unknown) => void][] = [
    [
      'undici:request:create',
      message => {
        const { request } = message as UndiciMessage;
        const finish = begin(request.origin, request.method, request.path);
        if (finish) undici.set(request, { finish });
      },
    ],
    [
      'undici:request:headers',
      message => {
        const { request, response } = message as UndiciMessage;
        const row = undici.get(request);
        if (row) row.status = response?.statusCode;
      },
    ],
    [
      'undici:request:trailers',
      message => {
        const { request } = message as UndiciMessage;
        const row = undici.get(request);
        if (row) {
          row.finish(outcome(row.status ?? 0), row.status);
          undici.delete(request);
        }
      },
    ],
    [
      'undici:request:error',
      message => {
        const { request, error } = message as UndiciMessage;
        const row = undici.get(request);
        if (row) {
          row.finish(aborted(error) ? 'aborted' : 'transport_error', row.status);
          undici.delete(request);
        }
      },
    ],
  ];
  // Public Undici diagnostic lifecycle events also cover Node's built-in fetch.
  // Unlike responseHook (headers only), trailers/error mark a terminal attempt.
  const safeSubscriptions = subscriptions.map(
    ([name, listener]) =>
      [
        name,
        (message: unknown) => {
          try {
            listener(message);
          } catch {
          if (healthy) {
            healthy = false;
              diag.warn(
                '[http-client-metrics] unsupported HTTP lifecycle payload; counters may be incomplete'
              );
            }
          }
        },
      ] as const
  );
  for (const [name, listener] of safeSubscriptions) channel(name).subscribe(listener);

  // Identity only: no recording span or trace attributes are required. Using the
  // instrumentation response hook avoids adding a ClientRequest response listener,
  // which would change Node/OTel's behavior when callers do not consume a body.
  const native = new WeakMap<
    Span,
    { finish: NonNullable<ReturnType<typeof begin>>; responseSeen: boolean }
  >();

  return {
    trackNodeRequest(span: Span, request: ClientRequest | IncomingMessage): void {
      if (!('getHeader' in request)) return;
      const host = request.getHeader('host');
      if (typeof host !== 'string') return;
      let origin: URL;
      try {
        origin = new URL(`${request.protocol}//${host}`);
      } catch {
        return;
      }
      if (
        origin.hostname.replace(/^\[|\]$/g, '').toLowerCase() !==
        request.host.replace(/^\[|\]$/g, '').toLowerCase()
      )
        return;
      const finish = begin(origin.origin, request.method, request.path);
      if (!finish) return;
      const row = { finish, responseSeen: false };
      native.set(span, row);
      request.once(errorMonitor, error => finish(aborted(error) ? 'aborted' : 'transport_error'));
      request.once('abort', () => finish('aborted'));
      request.once('close', () => {
        if (!row.responseSeen) finish(request.aborted ? 'aborted' : 'transport_error');
      });
    },
    trackNodeResponse(span: Span, response: IncomingMessage | ServerResponse): void {
      const row = native.get(span);
      if (!row || !('complete' in response)) return;
      row.responseSeen = true;
      const status = response.statusCode;
      response.once('end', () =>
        row.finish(response.complete ? outcome(status ?? 0) : 'transport_error', status)
      );
      response.once(errorMonitor, () => row.finish('transport_error', status));
      response.once('close', () => {
        if (!response.complete) row.finish('transport_error', status);
      });
    },
    close(): void {
      for (const [name, listener] of safeSubscriptions) channel(name).unsubscribe(listener);
      meter.removeBatchObservableCallback(observe, [attempts, completed, active]);
    },
  };
}
