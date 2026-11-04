import type { IncomingMessage, ServerResponse } from 'node:http';
import { Turn, type AssistantService } from './service';

/** Called only after the hosted staff boundary or local loopback/origin boundary. */
export async function assistantHttp(
  req: IncomingMessage,
  res: ServerResponse,
  service: AssistantService,
  owner: string
) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    res.writeHead(415);
    res.end();
    return;
  }
  if (Number(req.headers['content-length'] ?? 0) > 16_384) {
    res.writeHead(413);
    res.end();
    return;
  }
  const abort = new AbortController();
  const disconnect = () => {
    if (!res.writableEnded) abort.abort();
  };
  res.once('close', disconnect);
  try {
    let input: unknown = (req as IncomingMessage & { body?: unknown }).body;
    if (input === undefined) {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        length += Buffer.byteLength(chunk);
        if (length > 16_384) {
          res.writeHead(413);
          res.end();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      input = JSON.parse(Buffer.concat(chunks).toString());
    }
    const parsed = Turn.safeParse(input);
    if (!parsed.success) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid investigation request' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    try {
      await service.run(
        owner,
        parsed.data,
        event => {
          if (!abort.signal.aborted) res.write(JSON.stringify(event) + '\n');
        },
        abort.signal
      );
    } catch (error) {
      if (!abort.signal.aborted) {
        const message =
          error instanceof Error &&
          /^(Assistant |Conversation |Investigation |Response )/.test(error.message)
            ? error.message
            : 'Bedrock investigation unavailable. Check server AWS credentials, model access and region, then retry.';
        res.write(JSON.stringify({ type: 'error', message }) + '\n');
      }
    }
    res.end();
  } catch {
    if (!res.headersSent) res.writeHead(400);
    res.end();
  } finally {
    res.removeListener('close', disconnect);
  }
}
