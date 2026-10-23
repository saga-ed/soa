import type { Point } from './types';

/** Round only corners; endpoints remain exact so arrowheads meet their ports. */
export function roundedPath(points: Point[], radius = 8): string {
  if (!points.length) return '';
  const clean = points.filter(
    (point, index) =>
      index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y
  );
  let path = `M ${clean[0].x} ${clean[0].y}`;
  for (let index = 1; index < clean.length - 1; index++) {
    const previous = clean[index - 1];
    const point = clean[index];
    const next = clean[index + 1];
    const incoming = Math.hypot(point.x - previous.x, point.y - previous.y);
    const outgoing = Math.hypot(next.x - point.x, next.y - point.y);
    const turn =
      (point.x - previous.x) * (next.y - point.y) - (point.y - previous.y) * (next.x - point.x);
    const r = turn === 0 ? 0 : Math.min(Math.max(0, radius), incoming / 2, outgoing / 2);
    if (r === 0) {
      path += ` L ${point.x} ${point.y}`;
      continue;
    }
    const start = {
      x: point.x + ((previous.x - point.x) * r) / incoming,
      y: point.y + ((previous.y - point.y) * r) / incoming,
    };
    const end = {
      x: point.x + ((next.x - point.x) * r) / outgoing,
      y: point.y + ((next.y - point.y) * r) / outgoing,
    };
    path += ` L ${start.x} ${start.y} Q ${point.x} ${point.y} ${end.x} ${end.y}`;
  }
  if (clean.length > 1) {
    const last = clean[clean.length - 1];
    path += ` L ${last.x} ${last.y}`;
  }
  return path;
}
