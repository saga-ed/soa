import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { SaveView } from './schema';
import type { SavedChartView } from '../../../../web/vishnu/src/lib/graph/charts';
export class ChartError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}
/** Only definitions are persisted. Owner and server-selected scope constrain every operation. */
export class ChartViewStore {
  private ready?: Promise<unknown>;
  constructor(
    private pool: Pool,
    private scope: string
  ) {}
  init() {
    return (this.ready ??= this.pool
      .query(
        `CREATE TABLE IF NOT EXISTS vishnu_chart_view (
      id uuid PRIMARY KEY, owner text NOT NULL, scope text NOT NULL, name text NOT NULL,
      revision integer NOT NULL DEFAULT 1, definition jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
    ); CREATE INDEX IF NOT EXISTS vishnu_chart_view_owner_scope ON vishnu_chart_view(owner, scope);`
      )
      .catch(e => {
        this.ready = undefined;
        throw e;
      }));
  }
  private decode(row: any): SavedChartView {
    return {
      id: row.id,
      name: row.name,
      revision: row.revision,
      definition: row.definition,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }
  async list(owner: string) {
    await this.init();
    const rows = await this.pool.query(
      'SELECT id,name,revision,definition,updated_at FROM vishnu_chart_view WHERE owner=$1 AND scope=$2 ORDER BY updated_at DESC LIMIT 50',
      [owner, this.scope]
    );
    return rows.rows.map(r => this.decode(r));
  }
  async save(owner: string, input: unknown, id?: string) {
    const value = SaveView.parse(input);
    await this.init();
    if (id) {
      if (!value.revision) throw new ChartError(400, 'Revision required.');
      const rows = await this.pool.query(
        'UPDATE vishnu_chart_view SET name=$1,definition=$2,revision=revision+1,updated_at=now() WHERE id=$3 AND owner=$4 AND scope=$5 AND revision=$6 RETURNING *',
        [value.name, JSON.stringify(value.definition), id, owner, this.scope, value.revision]
      );
      if (!rows.rowCount)
        throw new ChartError(409, 'View changed or is unavailable. Reload the saved views.');
      return this.decode(rows.rows[0]);
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize each owner's quota across replicas without locking other owners.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `vishnu-chart-view:${owner}`,
      ]);
      const count = await client.query(
        'SELECT count(*)::int AS count FROM vishnu_chart_view WHERE owner=$1',
        [owner]
      );
      if (count.rows[0].count >= 50)
        throw new ChartError(409, 'Private view limit reached (50). Delete an old view first.');
      const rows = await client.query(
        'INSERT INTO vishnu_chart_view (id,owner,scope,name,definition) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [randomUUID(), owner, this.scope, value.name, JSON.stringify(value.definition)]
      );
      await client.query('COMMIT');
      return this.decode(rows.rows[0]);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async remove(owner: string, id: string) {
    await this.init();
    const result = await this.pool.query(
      'DELETE FROM vishnu_chart_view WHERE id=$1 AND owner=$2 AND scope=$3',
      [id, owner, this.scope]
    );
    if (!result.rowCount) throw new ChartError(404, 'View unavailable.');
  }
}
