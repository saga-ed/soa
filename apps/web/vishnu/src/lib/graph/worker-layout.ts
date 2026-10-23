import ELK from 'elkjs/lib/elk-api.js';
import workerUrl from 'elkjs/lib/elk-worker.min.js?url';
import { layoutMesh } from './layout';
import type { MeshLayout, MeshSnapshot } from './types';

/** Instantiate on mount; ELK's own classic worker runs the layout algorithm. */
export function createLayoutWorker() {
  const worker = new Worker(workerUrl);
  const engine = new ELK({ workerFactory: () => worker });
  const pending = new Set<(error: Error) => void>();
  let stopped: Error | undefined;
  const stop = (error: Error) => {
    stopped = error;
    worker.terminate();
    for (const reject of pending) reject(error);
    pending.clear();
  };
  worker.addEventListener('error', event => {
    event.preventDefault();
    stop(new Error(event.message || 'Layout worker failed'));
  });
  worker.addEventListener('messageerror', () =>
    stop(new Error('Layout worker message could not be read'))
  );

  return {
    layout(snapshot: MeshSnapshot): Promise<MeshLayout> {
      if (stopped) return Promise.reject(stopped);
      return new Promise((resolve, reject) => {
        pending.add(reject);
        layoutMesh(snapshot, engine)
          .then(resolve, reject)
          .finally(() => pending.delete(reject));
      });
    },
    terminate() {
      stop(new Error('Layout view closed'));
    },
  };
}
