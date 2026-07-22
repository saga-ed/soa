import type { ErrorRequestHandler } from 'express';

/**
 * Express error middleware that advertises the request body-size limit on
 * oversized-payload rejections, so clients can right-size their batch and retry
 * instead of failing opaquely. body-parser throws a PayloadTooLargeError with
 * `type: 'entity.too.large'` and a numeric `limit` (the configured byte cap).
 * Register this immediately AFTER the JSON body parser (see ExpressServer) so it
 * catches the parser's error before any downstream framework error handler.
 */
export function payloadTooLargeHandler(): ErrorRequestHandler {
  return (err, _req, res, next) => {
    const e = err as { type?: string; status?: number; statusCode?: number; limit?: number } | null;
    if (e && (e.type === 'entity.too.large' || e.status === 413 || e.statusCode === 413)) {
      if (typeof e.limit === 'number') res.setHeader('X-Max-Body-Bytes', String(e.limit));
      res.status(413).json({ error: 'payload_too_large', maxBodyBytes: e.limit ?? null });
      return;
    }
    next(err);
  };
}
