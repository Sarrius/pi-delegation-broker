import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

const KINDS = new Set(['quality', 'route', 'feedback', 'decision']);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('history requires finite JSON data');
  return value;
}
/** Shared controller ledger. Atomic idempotent events, no prompts or credentials at callers. */
export class RoutingHistoryStore {
  #db; #now; #transaction = false;
  constructor({ path, now = Date.now } = {}) {
    if (!isAbsolute(path ?? '') || typeof now !== 'function') throw new Error('history requires absolute path and clock');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.#now = now;
    this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS routing_history (sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, data TEXT NOT NULL, timestamp INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS routing_history_kind ON routing_history(kind,sequence);`);
  }
  append({ id, kind, data, timestamp = this.#now() } = {}) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(id) || !KINDS.has(kind)
      || !Number.isSafeInteger(timestamp) || timestamp < 0 || !data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid history event');
    const json = JSON.stringify(canonical(data));
    if (Buffer.byteLength(json) > 65536) throw new Error('history payload too large');
    return this.transaction(() => {
      const existing = this.#db.prepare('SELECT kind,data FROM routing_history WHERE id=?').get(id);
      if (existing && (existing.kind !== kind || existing.data !== json)) throw new Error('history event id collision');
      if (!existing) this.#db.prepare('INSERT INTO routing_history(id,kind,data,timestamp) VALUES(?,?,?,?)').run(id,kind,json,timestamp);
      return { inserted: !existing };
    });
  }
  transaction(fn) {
    if(this.#transaction) return fn();
    this.#db.exec('BEGIN IMMEDIATE'); this.#transaction=true;
    try {const result=fn();this.#db.exec('COMMIT');return result;}
    catch(error) {this.#db.exec('ROLLBACK');throw error;}
    finally {this.#transaction=false;}
  }

  list({ kind, limit = 2000 } = {}) {
    if ((kind !== undefined && !KINDS.has(kind)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100000) throw new Error('invalid history query');
    const rows = kind ? this.#db.prepare('SELECT id,kind,data,timestamp FROM routing_history WHERE kind=? ORDER BY sequence DESC LIMIT ?').all(kind,limit)
      : this.#db.prepare('SELECT id,kind,data,timestamp FROM routing_history ORDER BY sequence DESC LIMIT ?').all(limit);
    return rows.reverse().map(row => ({...row, data: JSON.parse(row.data)}));
  }
  count(kind) { return Number(kind ? this.#db.prepare('SELECT count(*) AS n FROM routing_history WHERE kind=?').get(kind).n : this.#db.prepare('SELECT count(*) AS n FROM routing_history').get().n); }
  close() { this.#db?.close(); this.#db = undefined; }
}
