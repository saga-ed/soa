export type Health = 'healthy' | 'warning' | 'critical' | 'unknown';
export type Band = 'data' | 'mesh' | 'application';
export type Freshness = 'fresh' | 'stale' | 'missing';
export interface Evidence {
  label: string;
  description: string;
  url?: string;
}
export interface System {
  runtimeState?: 'reachable' | 'unhealthy' | 'stopped' | 'not-started' | 'unknown';
  eventBus?: { publishes: boolean; consumes: boolean };
  id: string;
  label: string;
  band: Band;
  kind: string;
  health: Health;
  freshness: Freshness;
  summary: string;
  errors: number | null;
  evidence: Evidence[];
}
export interface Relationship {
  id: string;
  via?: string[];
  source: string;
  target: string;
  label: string;
  kind: 'http' | 'event' | 'database';
  protocol?: 'trpc' | 'rest' | 'mixed' | 'unknown';
  count: number | null;
  rate: number | null;
  latencyMs: number | null;
  health: Health;
  freshness: Freshness;
  summary: string;
  evidence: Evidence[];
}
export interface MeshSnapshot {
  topologyVersion: string;
  environment: string;
  mode: 'fixture' | 'live';
  slot?: number;
  observedAt: string;
  observationWindowSeconds: number;
  systems: System[];
  relationships: Relationship[];
}
export interface Point {
  x: number;
  y: number;
}
export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface LayoutEdge {
  id: string;
  points: Point[];
}
export interface MeshLayout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
}
