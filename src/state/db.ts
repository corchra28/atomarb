import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { jsonReplacer } from '../util/bigint.js'
/** Durable run registry and journal. Every write is inside a transaction; checkpoints are atomic. */
export class Db {
  readonly db: DatabaseSync
  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, started_utc TEXT NOT NULL, ended_utc TEXT, config_hash TEXT NOT NULL, config_json TEXT NOT NULL, status TEXT NOT NULL, stop_reason TEXT, summary_json TEXT);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, ts_utc TEXT NOT NULL, mono_ms INTEGER NOT NULL, kind TEXT NOT NULL, key TEXT, slot INTEGER, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_run_kind ON events(run_id, kind);
      CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, ts_utc TEXT NOT NULL, mono_ms INTEGER NOT NULL, mint TEXT NOT NULL, pool_a TEXT NOT NULL, pool_b TEXT NOT NULL, direction TEXT NOT NULL, amount_in TEXT NOT NULL, amount_out TEXT NOT NULL, trading_pnl TEXT NOT NULL, tx_pnl TEXT NOT NULL, state_hash TEXT NOT NULL, min_slot INTEGER, max_slot INTEGER, single_batch INTEGER NOT NULL, evidence TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS candidates_run ON candidates(run_id, ts_utc);
      CREATE TABLE IF NOT EXISTS simulations (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, candidate_id TEXT, ts_utc TEXT NOT NULL, environment TEXT NOT NULL, context_slot INTEGER, err TEXT, units_consumed INTEGER, message_hash TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints (run_id TEXT NOT NULL, name TEXT NOT NULL, ts_utc TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(run_id, name));
      CREATE TABLE IF NOT EXISTS rpc_usage (run_id TEXT NOT NULL, method TEXT NOT NULL, count INTEGER NOT NULL, errors INTEGER NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(run_id, method));
    `)
  }
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const r = fn(); this.db.exec('COMMIT'); return r } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  startRun(id: string, kind: string, configHash: string, config: unknown, startedUtc: string): void {
    this.tx(() => this.db.prepare('INSERT INTO runs (id,kind,started_utc,config_hash,config_json,status) VALUES (?,?,?,?,?,?)').run(id, kind, startedUtc, configHash, JSON.stringify(config, jsonReplacer), 'RUNNING'))
  }
  endRun(id: string, status: string, endedUtc: string, stopReason: string | null, summary: unknown): void {
    this.tx(() => this.db.prepare('UPDATE runs SET status=?, ended_utc=?, stop_reason=?, summary_json=? WHERE id=?').run(status, endedUtc, stopReason, JSON.stringify(summary, jsonReplacer), id))
  }
  event(runId: string, tsUtc: string, monoMs: number, kind: string, key: string | null, slot: number | null, payload: unknown): void {
    this.db.prepare('INSERT INTO events (run_id,ts_utc,mono_ms,kind,key,slot,payload) VALUES (?,?,?,?,?,?,?)').run(runId, tsUtc, monoMs, kind, key, slot, JSON.stringify(payload, jsonReplacer))
  }
  checkpoint(runId: string, name: string, tsUtc: string, payload: unknown): void {
    this.tx(() => this.db.prepare('INSERT OR REPLACE INTO checkpoints (run_id,name,ts_utc,payload) VALUES (?,?,?,?)').run(runId, name, tsUtc, JSON.stringify(payload, jsonReplacer)))
  }
  loadCheckpoint<T>(runId: string, name: string): T | null {
    const row = this.db.prepare('SELECT payload FROM checkpoints WHERE run_id=? AND name=?').get(runId, name) as { payload: string } | undefined
    return row ? (JSON.parse(row.payload) as T) : null
  }
  rpcUsage(runId: string, method: string, errors: number, bytes: number): void {
    this.db.prepare('INSERT INTO rpc_usage (run_id,method,count,errors,bytes) VALUES (?,?,1,?,?) ON CONFLICT(run_id,method) DO UPDATE SET count=count+1, errors=errors+excluded.errors, bytes=bytes+excluded.bytes').run(runId, method, errors, bytes)
  }
  close(): void { this.db.close() }
}
