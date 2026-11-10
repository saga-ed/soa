import { afterEach, expect, it, vi } from 'vitest';
import { readFile, readlink } from 'node:fs/promises';
import { readServiceProcessState } from '../mesh-view.js';
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(), readlink: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
const error = (code: string) => Object.assign(new Error(code), { code });
const setup = (cwd = '/checkout/apps/node/iam-api', env = 'PORT=6010\0') => {
  vi.mocked(readFile).mockResolvedValueOnce('1234\n').mockResolvedValueOnce(env);
  vi.mocked(readlink).mockResolvedValue(cwd);
  return vi.spyOn(process, 'kill').mockReturnValue(true);
};
it('accepts a live service process in the selected slot', async () => {
  setup();
  expect(await readServiceProcessState('/state', 'iam-api', 6010)).toBe('running');
});
it.each([
  ['/other/service', 'PORT=6010\0'],
  ['/checkout/apps/node/iam-api', 'PORT=3010\0'],
])('rejects a reused PID with the wrong service or slot', async (cwd, env) => {
  setup(cwd, env);
  expect(await readServiceProcessState('/state', 'iam-api', 6010)).toBe('unverified');
});
it('recognizes a stale PID without reading its environment', async () => {
  setup().mockImplementation(() => {
    throw error('ESRCH');
  });
  expect(await readServiceProcessState('/state', 'iam-api', 6010)).toBe('exited');
  expect(readlink).not.toHaveBeenCalled();
});
it('distinguishes a missing launch record from unreadable metadata', async () => {
  vi.mocked(readFile).mockRejectedValueOnce(error('ENOENT')).mockRejectedValueOnce(error('EACCES'));
  expect(await readServiceProcessState('/state', 'iam-api', 6010)).toBe('absent');
  expect(await readServiceProcessState('/state', 'iam-api', 6010)).toBe('unverified');
});
it('never treats an invalid PID as active', async () => {
  vi.mocked(readFile).mockResolvedValueOnce('-1');
  const kill = vi.spyOn(process, 'kill');
  expect(await readServiceProcessState('/state', 'iam-api', 6010)).toBe('unverified');
  expect(kill).not.toHaveBeenCalled();
});

it('verifies a frontend whose port is supplied as a command argument', async () => {
  setup('/checkout/apps/web/vishnu', 'pnpm dev --strictPort --port 11930');
  expect(await readServiceProcessState('/state', 'vishnu', 11930)).toBe('running');
});
