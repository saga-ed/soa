// Structural subsets of `pg` types so lake-writer carries no pg dependency.
// A pg Pool / PoolClient satisfies these.

export interface SqlLike {
  query<R = unknown>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

export interface PgClientLike extends SqlLike {
  release(): void;
}

export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
}
