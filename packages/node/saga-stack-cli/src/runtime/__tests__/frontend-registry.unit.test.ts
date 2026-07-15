import { describe, expect, it } from 'vitest';
import {
  type FrontendRegistryIo,
  clearRegistry,
  frontendRegistryPath,
  readRegistry,
  upsertRegistry,
} from '../frontend-registry.js';

function fakeIo(seed: Record<string, string> = {}): FrontendRegistryIo & { files: Record<string, string> } {
  const files: Record<string, string> = { ...seed };
  return {
    files,
    read: (p) => (p in files ? files[p] : null),
    write: (p, c) => {
      files[p] = c;
    },
    remove: (p) => {
      delete files[p];
    },
  };
}

const SD = '/tmp/sds-synthetic-s1';
const REC = { label: 'main', path: '/home/me/dash', port: 9901, pid: 4242, slot: 1 };

describe('frontend-registry', () => {
  it('path is <stateDir>/frontends.json', () => {
    expect(frontendRegistryPath(SD)).toBe('/tmp/sds-synthetic-s1/frontends.json');
  });

  it('read returns {} when absent or malformed', () => {
    expect(readRegistry(SD, fakeIo())).toEqual({});
    expect(readRegistry(SD, fakeIo({ [frontendRegistryPath(SD)]: 'not json' }))).toEqual({});
  });

  it('read returns {} when the file holds a JSON array (not a valid registry)', () => {
    expect(readRegistry(SD, fakeIo({ [frontendRegistryPath(SD)]: '[1,2,3]' }))).toEqual({});
  });

  it('upsert writes the record keyed by label; read round-trips', () => {
    const io = fakeIo();
    upsertRegistry(SD, REC, io);
    expect(readRegistry(SD, io)).toEqual({ main: REC });
    // second label merges, doesn't clobber.
    upsertRegistry(SD, { ...REC, label: 'feat', port: 9902 }, io);
    expect(Object.keys(readRegistry(SD, io)).sort()).toEqual(['feat', 'main']);
  });

  it('clear removes the file', () => {
    const io = fakeIo();
    upsertRegistry(SD, REC, io);
    clearRegistry(SD, io);
    expect(readRegistry(SD, io)).toEqual({});
  });
});
