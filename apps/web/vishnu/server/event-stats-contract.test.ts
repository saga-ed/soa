import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('pins the exact shared v1 contract consumed by Vishnu', () => {
  const pinned = readFileSync(new URL('../contracts/event-stats.v1.json', import.meta.url), 'utf8');
  const shared = readFileSync(
    new URL('../../../../packages/node/event-stats/contracts/event-stats.v1.json', import.meta.url),
    'utf8'
  );
  expect(JSON.parse(pinned)).toEqual(JSON.parse(shared));
});
