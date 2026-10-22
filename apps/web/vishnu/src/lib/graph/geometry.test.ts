import { expect, it } from 'vitest';
import { roundedPath } from './geometry';

it('keeps endpoints exact and rounds short corners without overshoot', () => {
  expect(
    roundedPath([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 20 },
    ])
  ).toBe('M 0 0 L 2 0 Q 4 0 4 2 L 4 20');
});

it('handles empty, single, repeated and collinear points', () => {
  expect(roundedPath([])).toBe('');
  expect(roundedPath([{ x: 1, y: 2 }])).toBe('M 1 2');
  expect(
    roundedPath([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 8, y: 0 },
    ])
  ).toBe('M 0 0 L 4 0 L 8 0');
});
