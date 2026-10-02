import { describe, expect, it } from 'vitest';
import { renderNextSteps } from '../index.js';

describe('renderNextSteps', () => {
  const lines = renderNextSteps({
    heading: 'In ANOTHER terminal:',
    steps: [
      { label: 'Load the password:', command: 'PW="$(aws ...)"' },
      { label: 'Connect:', command: 'mongosh "mongodb://..."' },
    ],
    notes: ['check db.hello()'],
  });

  it('puts each command flush-left on its own line, surrounded by blank lines', () => {
    for (const cmd of ['PW="$(aws ...)"', 'mongosh "mongodb://..."']) {
      const i = lines.indexOf(cmd);
      expect(i).toBeGreaterThan(0);
      expect(lines[i - 1]).toBe('');
      expect(lines[i + 1]).toBe('');
    }
  });

  it('numbers the steps and lists notes after them', () => {
    expect(lines).toContain('1. Load the password:');
    expect(lines).toContain('2. Connect:');
    expect(lines.indexOf('  • check db.hello()')).toBeGreaterThan(lines.indexOf('2. Connect:'));
  });

  it('omits the notes section when there are none', () => {
    expect(renderNextSteps({ heading: 'h', steps: [{ label: 'l', command: 'c' }] })).not.toContain('Notes:');
  });
});
