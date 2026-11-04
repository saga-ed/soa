import { initialInvestigation, type InvestigationState, type SortColumn } from './investigation';
import type { SignalView } from './datadog';
import type { MeshSnapshot } from './types';

export type ResourceSort = 'cpu' | 'memory';
export interface ViewState {
  selected: string | null;
  signalView: SignalView;
  investigation: InvestigationState;
  showInspector: boolean;
  showResources: boolean;
  resourceSystem: string;
  resourceSort: ResourceSort;
}
export type ViewAction =
  | {
      type: 'show_calls';
      view: 'hot' | 'slow' | 'fanout';
      system: string;
      direction: 'both' | 'from' | 'to';
      path?: string;
      sort?: SortColumn;
    }
  | { type: 'show_resources'; system: string; sort: ResourceSort }
  | { type: 'reset_view' }
  | { type: 'restore_view' };
export const initialView = (): ViewState => ({
  selected: null,
  signalView: 'overview',
  investigation: initialInvestigation(),
  showInspector: false,
  showResources: false,
  resourceSystem: '',
  resourceSort: 'cpu',
});
export const viewKey = (view: ViewState) => JSON.stringify(view);

/** Both manual navigation and assistant navigation use this atomic transition. */
export function applyView(
  view: ViewState,
  action: ViewAction,
  mesh: MeshSnapshot,
  previous?: ViewState
): ViewState {
  if (action.type === 'restore_view') return previous ? structuredClone(previous) : view;
  if (action.type === 'reset_view') return initialView();
  if (action.system && !mesh.systems.some(s => s.id === action.system))
    throw new Error('System is no longer in this mesh');
  if (action.type === 'show_resources')
    return {
      ...view,
      selected: action.system || null,
      showResources: true,
      showInspector: false,
      resourceSystem: action.system,
      resourceSort: action.sort,
    };
  const path = action.path ? mesh.relationships.find(r => r.id === action.path) : null;
  if (action.path && !path) throw new Error('Path is no longer in this mesh');
  if (
    path &&
    action.system &&
    !(action.direction === 'from'
      ? path.source === action.system
      : action.direction === 'to'
        ? path.target === action.system
        : [path.source, path.target].includes(action.system))
  )
    throw new Error('Path does not match the system filter');
  return {
    ...view,
    selected: path?.id ?? (action.system || null),
    signalView: action.view,
    showResources: false,
    showInspector: true,
    investigation: {
      ...initialInvestigation(),
      mode: 'table',
      system: action.system,
      direction: action.direction,
      path: path?.id ?? null,
      sort:
        action.sort ??
        (action.view === 'slow' ? 'p95' : action.view === 'fanout' ? 'meanCalls' : null),
      sortView: action.view,
    },
  };
}

export interface ResourceInstance {
  system: string;
  instance: string;
  deployment: string;
  cpuCores: number | null;
  cpuLimitCores: number | null;
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  memoryPercent: number | null;
  observedAt: string;
}
export interface ResourceSnapshot {
  status: 'ready' | 'unconfigured' | 'unavailable' | 'empty';
  source: 'datadog';
  scope: { environment: string; deployment: string; machine?: string };
  observedAt: string;
  window: { from: number; to: number };
  instances: ResourceInstance[];
  message: string;
}
export const resourcePressure = (r: ResourceInstance) =>
  Math.max(r.cpuPercent ?? 0, r.memoryPercent ?? 0);
export function resourceRows(
  data: ResourceSnapshot | null,
  system: string,
  sort: ResourceSort,
  now = Date.now()
) {
  if (!data || data.status !== 'ready' || now - Date.parse(data.observedAt) > 120_000) return [];
  return data.instances
    .filter(r => (!system || r.system === system) && now - Date.parse(r.observedAt) < 180_000)
    .sort((a, b) => {
      const av = sort === 'cpu' ? a.cpuPercent : a.memoryPercent;
      const bv = sort === 'cpu' ? b.cpuPercent : b.memoryPercent;
      if (av !== null || bv !== null) return (bv ?? -1) - (av ?? -1);
      return (
        ((sort === 'cpu' ? b.cpuCores : b.memoryBytes) ?? -1) -
        ((sort === 'cpu' ? a.cpuCores : a.memoryBytes) ?? -1)
      );
    });
}
export type AssistantEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'evidence'; label: string; detail: string }
  | { type: 'view'; action: ViewAction; contextKey: string }
  | {
      type: 'done';
      conversationId: string;
      model: string;
      usage?: { inputTokens: number; outputTokens: number; toolCalls: number };
    }
  | { type: 'error'; message: string };
