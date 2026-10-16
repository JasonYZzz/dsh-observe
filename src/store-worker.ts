import { parentPort, workerData } from 'node:worker_threads';
import { mkdir, chmod } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync, backup, type SQLInputValue } from 'node:sqlite';
import { withFileLock } from '@deepseek-ai/dsh-atomic-write';
import { fold, initialState } from './fold.js';
import type { Binding, EventSummary, FoldState, Log, Run, SessionInfo } from './types.js';

const port = parentPort!;
const directory = workerData.directory as string;
await mkdir(directory, { recursive: true, mode: 0o700 });
const path = join(directory, 'observe.sqlite');
try {
  await withFileLock(path, async () => {
    const db = new DatabaseSync(path);
    try {
      await chmod(path, 0o600);
      const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (version > 2) throw new Error('Unsupported database schema');
      if (Object.values(db.prepare('PRAGMA quick_check').get()!)[0] !== 'ok') throw new Error('Corrupt observation database');
      if (version > 0 && version < 2) {
        const target = `${path}.schema-${version}-${Date.now()}.bak`;
        await backup(db, target); await chmod(target, 0o600);
      }
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS session_index (id TEXT PRIMARY KEY, info TEXT NOT NULL, watermark INTEGER NOT NULL, state TEXT NOT NULL, error TEXT, revision INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, revision INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS runs_time ON runs(time DESC,id DESC);
        CREATE INDEX IF NOT EXISTS runs_session ON runs(session_id,time DESC,id DESC);
        CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, parent_id TEXT, seq INTEGER NOT NULL, data TEXT NOT NULL, revision INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS nodes_run ON nodes(run_id,seq,id);
        CREATE INDEX IF NOT EXISTS nodes_session ON nodes(session_id,seq,id);
        CREATE TABLE IF NOT EXISTS links (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY, time INTEGER NOT NULL, level TEXT NOT NULL, source TEXT NOT NULL, session_id TEXT, run_id TEXT, node_id TEXT, summary TEXT NOT NULL, bytes INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS logs_time ON logs(time DESC,id DESC);
        CREATE INDEX IF NOT EXISTS logs_session ON logs(session_id,time DESC,id DESC);
        CREATE TABLE IF NOT EXISTS context_bindings (session_id TEXT NOT NULL, ref_kind TEXT NOT NULL, ref_id TEXT NOT NULL, data TEXT NOT NULL, bound_at INTEGER NOT NULL, PRIMARY KEY(session_id,ref_kind,ref_id));
        PRAGMA user_version=2;`);
      db.prepare('INSERT OR IGNORE INTO metadata VALUES (?, ?)').run('namespace', randomUUID());
      db.prepare('INSERT OR IGNORE INTO metadata VALUES (?, ?)').run('revision', '0');
      const namespace = String(db.prepare('SELECT value FROM metadata WHERE key=?').get('namespace')!.value);
      let revision = Number(db.prepare('SELECT value FROM metadata WHERE key=?').get('revision')!.value);
      if (Number(db.prepare("SELECT count(*) AS count FROM runs WHERE status='running'").get()!.count) > 0) {
        transaction(() => {
        revision++;
        db.prepare('UPDATE metadata SET value=? WHERE key=?').run(String(revision), 'revision');
        db.prepare("UPDATE runs SET status='unknown',data=json_set(data,'$.status','unknown','$.revision',?),revision=? WHERE status='running'").run(revision,revision);
        db.prepare("UPDATE nodes SET data=json_set(data,'$.status','unknown','$.revision',?),revision=? WHERE json_extract(data,'$.status')='running'").run(revision,revision);
        db.exec("UPDATE session_index SET state=json_set(state,'$.run.status','unknown') WHERE json_extract(state,'$.run.status')='running'");
        });
      }
      const bump = () => { db.prepare('UPDATE metadata SET value=? WHERE key=?').run(String(++revision), 'revision'); return revision; };
      function transaction<T>(operation: () => T): T {
        const before = revision;
        db.exec('BEGIN IMMEDIATE');
        try { const result = operation(); db.exec('COMMIT'); return result; }
        catch (error) { db.exec('ROLLBACK'); revision = before; throw error; }
      }
      const size = (file: string) => { try { return statSync(file).size; } catch { return 0; } };
      function ingest(info: SessionInfo, events: EventSummary[]) {
        return transaction(() => {
          const row = db.prepare('SELECT state FROM session_index WHERE id=?').get(info.id);
          const state: FoldState = row ? JSON.parse(String(row.state)) : initialState();
          for (const event of events) {
            if (event.seq <= state.watermark) continue;
            const changes = fold(state, info, event, namespace);
            const currentRevision = bump();
            for (const run of changes.runs) {
              run.revision = currentRevision;
              db.prepare('INSERT INTO runs VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data,revision=excluded.revision')
                .run(run.id, run.sessionId, run.startTime, run.status, JSON.stringify(run), currentRevision);
            }
            for (const node of changes.nodes) {
              node.revision = currentRevision;
              db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,revision=excluded.revision')
                .run(node.id, node.sessionId, node.runId, node.parentId, node.sourceSeq, JSON.stringify(node), currentRevision);
            }
          }
          db.prepare('INSERT INTO session_index VALUES (?,?,?,?,NULL,?) ON CONFLICT(id) DO UPDATE SET info=excluded.info,watermark=excluded.watermark,state=excluded.state,error=NULL,revision=excluded.revision')
            .run(info.id, JSON.stringify(info), state.watermark, JSON.stringify(state), revision);
          if (info.parentSession) db.prepare('INSERT OR REPLACE INTO links VALUES (?,?,?)').run(`${info.id}:parent`, info.id,
            JSON.stringify({ kind: 'lineage', sessionId: info.id, parentSession: info.parentSession, evidence: 'native-header' }));
          return { indexedThroughSeq: state.watermark, coverage: state.coverage, asOfRevision: revision };
        });
      }
      const decode = (row: Record<string, unknown>) => JSON.parse(String(row.data));
      function paginate(table: 'runs' | 'nodes' | 'logs', input: Record<string, unknown>) {
        const { cursor, limit: requested, ...filters } = input;
        const limit = Number(requested ?? 50);
        const fingerprint = createHash('sha256').update(JSON.stringify([table, filters])).digest('hex');
        const clauses: string[] = []; const args: SQLInputValue[] = [];
        const add = (sql: string, ...values: SQLInputValue[]) => { clauses.push(sql); args.push(...values); };
        let checkpoint: { key: string | number; position: number; fingerprint: string } | undefined;
        if (cursor) {
          try { checkpoint = JSON.parse(Buffer.from(String(cursor), 'base64url').toString()); } catch { throw new Error('invalid_cursor'); }
          if (checkpoint?.fingerprint !== fingerprint || !Number.isSafeInteger(checkpoint.position) || !['string', 'number'].includes(typeof checkpoint.key)) throw new Error('invalid_cursor');
        }
        const columns: Record<string, string> = { sessionId: 'session_id', runId: 'run_id', nodeId: 'node_id', parentId: 'parent_id', source: 'source', level: 'level', status: 'status' };
        for (const [name, column] of Object.entries(columns)) {
          if (filters[name] !== undefined) add(`${table === 'nodes' && name === 'nodeId' ? 'id' : column}=?`, filters[name] as string);
        }
        if (table === 'runs') {
          if (filters.agentId) add("json_extract(data,'$.agentId')=?", String(filters.agentId));
          if (filters.model) add("EXISTS(SELECT 1 FROM json_each(runs.data,'$.models') WHERE value=?)", String(filters.model));
          if (filters.requestId) add("EXISTS(SELECT 1 FROM json_each(runs.data,'$.requestIds') WHERE value=?)", String(filters.requestId));
          if (filters.userId) add(`EXISTS(SELECT 1 FROM context_bindings b WHERE b.session_id=runs.session_id AND json_extract(b.data,'$.userId')=? AND
            ((b.ref_kind='request' AND b.ref_id IN (SELECT value FROM json_each(runs.data,'$.requestIds'))) OR (b.ref_kind='message' AND b.ref_id IN (SELECT value FROM json_each(runs.data,'$.messageIds')))))`, String(filters.userId));
          if (filters.unbound === true) add(`NOT EXISTS(SELECT 1 FROM context_bindings b WHERE b.session_id=runs.session_id AND
            ((b.ref_kind='request' AND b.ref_id IN (SELECT value FROM json_each(runs.data,'$.requestIds'))) OR (b.ref_kind='message' AND b.ref_id IN (SELECT value FROM json_each(runs.data,'$.messageIds')))))`);
        }
        if (filters.from !== undefined) add('time>=?', Number(filters.from));
        if (filters.to !== undefined) add('time<=?', Number(filters.to));
        if (table === 'logs' && filters.unassociated === true) add('session_id IS NULL');
        if (filters.standalone === true) add('run_id IS NULL');
        if (filters.afterRevision !== undefined) add('revision>?', Number(filters.afterRevision));
        if (filters.text) add('instr(lower(summary),lower(?))>0', String(filters.text));
        const position = table === 'nodes' ? 'seq' : 'time';
        const order = table === 'nodes' ? 'ASC' : 'DESC';
        if (checkpoint) add(`(${position},id) ${order === 'ASC' ? '>' : '<'} (?,?)`, checkpoint.position, checkpoint.key);
        const rows = db.prepare(`SELECT * FROM ${table}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY ${position} ${order},id ${order} LIMIT ?`).all(...args, limit + 1);
        const selected = rows.slice(0, limit);
        const last = selected.at(-1);
        return { items: selected.map((row) => table === 'logs' ? { id: row.id, time: row.time, level: row.level, source: row.source, summary: row.summary,
          sessionId: row.session_id, runId: row.run_id, nodeId: row.node_id } : decode(row)),
          nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ fingerprint, position: last[position], key: last.id })).toString('base64url') : null,
          asOfRevision: revision };
      }
      let logWrites = 0;
      function handle(operation: string, payload: any): unknown {
        switch (operation) {
          case 'health': return { status: 'ready', schemaVersion: 2, namespace, revision, bytes: size(path), walBytes: size(`${path}-wal`) };
          case 'batch': return ingest(payload.info, payload.events);
          case 'session.inactive': return transaction(() => {
            const changed = bump();
            db.prepare("UPDATE runs SET status='unknown',data=json_set(data,'$.status','unknown','$.revision',?),revision=? WHERE session_id=? AND status='running'").run(changed,changed,payload.sessionId);
            db.prepare("UPDATE nodes SET data=json_set(data,'$.status','unknown','$.revision',?),revision=? WHERE session_id=? AND json_extract(data,'$.status')='running'").run(changed,changed,payload.sessionId);
            db.prepare("UPDATE session_index SET state=json_set(state,'$.run.status','unknown') WHERE id=? AND json_extract(state,'$.run.status')='running'").run(payload.sessionId);
            return null;
          });
          case 'session.get': {
            const row = db.prepare('SELECT info,watermark,error FROM session_index WHERE id=?').get(payload.sessionId);
            return row ? { info: JSON.parse(String(row.info)), indexedThroughSeq: row.watermark, error: row.error } : null;
          }
          case 'session.error': {
            const state = initialState(); state.coverage = 'partial';
            db.prepare('INSERT INTO session_index VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET error=excluded.error,revision=excluded.revision')
              .run(payload.info.id, JSON.stringify(payload.info), -1, JSON.stringify(state), String(payload.error).slice(0, 256), bump());
            return null;
          }
          case 'capture.health': return { failedSessions: Number(db.prepare('SELECT count(*) AS count FROM session_index WHERE error IS NOT NULL').get()!.count),
            sessions: db.prepare('SELECT id,watermark,error FROM session_index ORDER BY revision DESC LIMIT 50').all() };
          case 'runs.list': return paginate('runs', payload);
          case 'runs.nodes': return paginate('nodes', payload);
          case 'logs.list': {
            const scope = Object.entries({ sessionId: 'session_id', runId: 'run_id', nodeId: 'node_id' }).filter(([key]) => payload[key] !== undefined);
            const clauses = scope.map(([, column]) => `${column}=?`);
            if (payload.unassociated === true) clauses.push('session_id IS NULL');
            const scopeCount = Number(db.prepare(`SELECT count(*) AS count FROM logs${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}`).get(...scope.map(([key]) => payload[key]))!.count);
            const unassociatedCount = Number(db.prepare('SELECT count(*) AS count FROM logs WHERE session_id IS NULL').get()!.count);
            return { ...paginate('logs', payload), scopeCount, unassociatedCount };
          }
          case 'runs.get': {
            const row = db.prepare('SELECT data FROM runs WHERE id=?').get(payload.runId);
            if (!row) return null;
            const run = decode(row) as Run;
            const contexts = db.prepare(`SELECT DISTINCT data,bound_at FROM context_bindings WHERE session_id=? AND
              ((ref_kind='request' AND ref_id IN (SELECT value FROM json_each(?))) OR (ref_kind='message' AND ref_id IN (SELECT value FROM json_each(?)))) LIMIT 200`)
              .all(run.sessionId, JSON.stringify(run.requestIds), JSON.stringify(run.messageIds))
              .map((row) => ({ ...decode(row), boundAt: row.bound_at, association: Number(row.bound_at) > run.startTime ? 'late' : 'prebound', identitySource: 'trusted-plugin' }));
            return { ...run, contexts, sessionStatus: db.prepare('SELECT watermark,error FROM session_index WHERE id=?').get(run.sessionId), identitySource: contexts.length ? 'trusted-plugin' : 'native-operator',
              links: db.prepare('SELECT data FROM links WHERE session_id=? LIMIT 200').all(run.sessionId).map(decode),
              asOfRevision: revision };
          }
          case 'logs.add': return transaction(() => {
            for (const log of payload as Log[]) {
              const runId = log.runId ?? (log.sessionId && Number.isSafeInteger(log.nativeTurn) ? db.prepare("SELECT id FROM runs WHERE session_id=? AND json_extract(data,'$.turn')=? LIMIT 1").get(log.sessionId,log.nativeTurn!)?.id as string | undefined : null) ?? null;
              const nodeId = log.nodeId ?? (runId && log.nativeCallId && Number.isSafeInteger(log.nativeStep) ? db.prepare("SELECT id FROM nodes WHERE run_id=? AND json_extract(data,'$.callId')=? AND json_extract(data,'$.step')=? LIMIT 1").get(runId,log.nativeCallId,log.nativeStep!)?.id as string | undefined : null) ?? null;
              db.prepare('INSERT INTO logs(time,level,source,session_id,run_id,node_id,summary,bytes) VALUES (?,?,?,?,?,?,?,?)')
              .run(log.time, log.level, log.source, log.sessionId, runId, nodeId, log.summary, Buffer.byteLength(log.summary) + 256);
            }
            db.prepare('DELETE FROM logs WHERE time<?').run(Date.now() - 7 * 86400000);
            if (++logWrites % 128 === 1) db.exec('DELETE FROM logs WHERE id IN (SELECT id FROM (SELECT id,sum(bytes) OVER (ORDER BY id DESC) AS total FROM logs) WHERE total>268435456)');
            bump(); return null;
          });
          case 'context.bind': return transaction(() => {
            const binding = payload as Binding; const value = JSON.stringify(binding);
            for (const [kind, id] of [['request', binding.requestId], ['message', binding.messageId]]) {
              if (!id) continue;
              const existing = db.prepare('SELECT data FROM context_bindings WHERE session_id=? AND ref_kind=? AND ref_id=?').get(binding.sessionId, kind!, id);
              if (existing && existing.data !== value) throw new Error('binding_conflict');
              db.prepare('INSERT OR IGNORE INTO context_bindings VALUES (?,?,?,?,?)').run(binding.sessionId, kind!, id, value, Date.now());
            }
            bump(); return { ok: true };
          });
          case 'rebuild': return transaction(() => {
            // Only derived rows are cleared; logs and trusted bindings are irreplaceable.
            for (const table of ['runs', 'nodes', 'links', 'session_index']) db.exec(`DELETE FROM ${table}`);
            bump(); return null;
          });
          default: throw new Error('unsupported_operation');
        }
      }
      port.postMessage({ ready: true });
      await new Promise<void>((resolve) => {
        port.on('message', ({ id, operation, payload }) => {
          if (operation === 'close') { resolve(); return; }
          try { port.postMessage({ id, value: handle(operation, payload) }); }
          catch (error) { const code = error instanceof Error && ['binding_conflict', 'invalid_cursor'].includes(error.message) ? error.message : 'store_operation_failed'; port.postMessage({ id, error: code }); }
        });
      });
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { db.close(); }
  }, { waitMs: 500 });
} catch {
  port.postMessage({ fatal: 'Observation database unavailable, locked or incompatible; preserve existing data and inspect Host diagnostics' });
  process.exitCode = 1;
} finally { port.close(); }
