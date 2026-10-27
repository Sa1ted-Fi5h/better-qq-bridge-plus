// 三层记忆的持久层：SQLite（node:sqlite，Node >= 22.5 内置，本机 Node 24 可用）。
//
// 设计：
//   - 短期记忆 = DSH 会话上下文窗口（不在这里，桥接只负责把最近消息喂给模型）
//   - 中期记忆 = summaries 表里的滚动摘要（桥接每 5 分钟把较早的消息压成一段）
//   - 长期记忆 = events 表里 importance >= 2 的重要事件（owner 发言、被 @、AI 主动记的事）
//
// 所有写入都是 append-only；摘要只追加、不改旧摘要，游标存在 kv 表里。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'message',
  sender TEXT,
  user_id TEXT,
  text TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 1,
  tags TEXT,
  source TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_key_ts ON events(key, ts);
CREATE INDEX IF NOT EXISTS idx_events_key_imp ON events(key, importance);
CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  from_ts INTEGER NOT NULL,
  to_ts INTEGER NOT NULL,
  text TEXT NOT NULL,
  msg_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_summaries_key_ts ON summaries(key, to_ts);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
`;

function fmtClock(ts) {
  const d = new Date(Number(ts) || 0);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function openMemoryStore({ dbPath } = {}) {
  if (!dbPath) throw new Error('memory-store: dbPath required');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);

  const q = {
    insEvent: db.prepare('INSERT INTO events (key, ts, kind, sender, user_id, text, importance, tags, source) VALUES (?,?,?,?,?,?,?,?,?)'),
    insSummary: db.prepare('INSERT INTO summaries (key, from_ts, to_ts, text, msg_count, created_at) VALUES (?,?,?,?,?,?)'),
    getKv: db.prepare('SELECT v FROM kv WHERE k = ?'),
    setKv: db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
    recentImportant: db.prepare('SELECT * FROM events WHERE key = ? AND importance >= ? ORDER BY ts DESC LIMIT ?'),
    window: db.prepare('SELECT * FROM events WHERE key = ? AND ts > ? AND ts <= ? ORDER BY ts ASC LIMIT ?'),
    summaries: db.prepare('SELECT * FROM summaries WHERE key = ? ORDER BY to_ts DESC LIMIT ?'),
    search: db.prepare('SELECT * FROM events WHERE key = ? AND (text LIKE ? OR sender LIKE ?) ORDER BY ts DESC LIMIT ?'),
    countEvents: db.prepare('SELECT COUNT(*) AS n FROM events'),
    countSummaries: db.prepare('SELECT COUNT(*) AS n FROM summaries'),
    keys: db.prepare("SELECT DISTINCT key FROM events WHERE kind = 'message'"),
  };

  return {
    dbPath,

    // 一条入站消息 / 事件落库。kind: message | event | reminder
    addEvent({ key, ts = Date.now(), kind = 'message', sender = '', userId = null, text = '', importance = 1, tags = null, source = null }) {
      const t = clip(text, 2000);
      if (!t) return 0;
      const imp = Math.min(3, Math.max(0, Number(importance) || 0));
      const info = q.insEvent.run(String(key), Number(ts) || Date.now(), String(kind), String(sender || ''), userId ? String(userId) : null, t, imp, tags ? String(tags) : null, source ? String(source) : null);
      return Number(info.lastInsertRowid) || 0;
    },

    // 长期记忆：最近的重要事件
    recentImportant(key, { minImportance = 2, limit = 8 } = {}) {
      return q.recentImportant.all(String(key), Number(minImportance) || 0, Number(limit) || 8);
    },

    // 取某段时间窗口内的消息（供滚动摘要）
    window(key, fromTsExclusive, toTsInclusive, limit = 300) {
      return q.window.all(String(key), Number(fromTsExclusive) || 0, Number(toTsInclusive) || Date.now(), Number(limit) || 300);
    },

    addSummary({ key, fromTs, toTs, text, msgCount = 0 }) {
      const t = clip(text, 6000);
      if (!t) return 0;
      const info = q.insSummary.run(String(key), Number(fromTs) || 0, Number(toTs) || 0, t, Number(msgCount) || 0, Date.now());
      return Number(info.lastInsertRowid) || 0;
    },

    // 中期记忆：最近 N 段滚动摘要（按时间倒序返回）
    recentSummaries(key, limit = 2) {
      return q.summaries.all(String(key), Number(limit) || 2);
    },

    search(key, query, limit = 10) {
      const like = `%${String(query || '').replace(/[%_]/g, (c) => '\\' + c)}%`;
      return q.search.all(String(key), like, like, Number(limit) || 10);
    },

    getCursor(key) {
      const row = q.getKv.get(`summary:${key}`);
      return row ? Number(row.v) || 0 : 0;
    },

    setCursor(key, ts) {
      q.setKv.run(`summary:${key}`, String(Number(ts) || 0));
    },

    allKeys() {
      return q.keys.all().map((r) => String(r.key));
    },

    // 控制台：分页列出某个会话的事件（可按关键词/重要性过滤）
    listEvents(key, { offset = 0, limit = 50, query = '', minImportance = 0 } = {}) {
      const where = ['key = ?'];
      const params = [String(key)];
      const imp = Number(minImportance) || 0;
      if (imp > 0) { where.push('importance >= ?'); params.push(imp); }
      const qText = String(query || '').trim();
      if (qText) {
        where.push('(text LIKE ? OR sender LIKE ?)');
        const like = `%${qText.replace(/[%_]/g, (c) => '\\' + c)}%`;
        params.push(like, like);
      }
      const w = where.join(' AND ');
      const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${w}`).get(...params)?.n) || 0;
      const items = db.prepare(`SELECT * FROM events WHERE ${w} ORDER BY ts DESC LIMIT ? OFFSET ?`)
        .all(...params, Number(limit) || 50, Number(offset) || 0);
      return { total, items };
    },

    deleteEvents(ids) {
      const list = (Array.isArray(ids) ? ids : [ids]).map((x) => Number(x)).filter((x) => x > 0);
      if (!list.length) return 0;
      const stmt = db.prepare('DELETE FROM events WHERE id = ?');
      let n = 0;
      for (const id of list) n += Number(stmt.run(id).changes) || 0;
      return n;
    },

    // 控制台：某会话的全部摘要（新→旧）
    listSummaries(key) {
      return db.prepare('SELECT * FROM summaries WHERE key = ? ORDER BY to_ts DESC').all(String(key));
    },

    deleteSummaries(ids) {
      const list = (Array.isArray(ids) ? ids : [ids]).map((x) => Number(x)).filter((x) => x > 0);
      if (!list.length) return 0;
      const stmt = db.prepare('DELETE FROM summaries WHERE id = ?');
      let n = 0;
      for (const id of list) n += Number(stmt.run(id).changes) || 0;
      return n;
    },

    // 清空一个会话的全部记忆（事件 + 摘要 + 游标）
    purgeKey(key) {
      const k = String(key);
      const ev = Number(db.prepare('DELETE FROM events WHERE key = ?').run(k).changes) || 0;
      const su = Number(db.prepare('DELETE FROM summaries WHERE key = ?').run(k).changes) || 0;
      db.prepare('DELETE FROM kv WHERE k = ?').run(`summary:${k}`);
      return { events: ev, summaries: su };
    },

    // 控制台：按会话汇总
    overview() {
      const ev = db.prepare('SELECT key, COUNT(*) AS n, SUM(CASE WHEN importance >= 2 THEN 1 ELSE 0 END) AS imp, MAX(ts) AS last FROM events GROUP BY key').all();
      const su = db.prepare('SELECT key, COUNT(*) AS n FROM summaries GROUP BY key').all();
      const map = new Map();
      for (const r of ev) map.set(String(r.key), { key: String(r.key), events: Number(r.n) || 0, important: Number(r.imp) || 0, summaries: 0, lastTs: Number(r.last) || 0 });
      for (const r of su) {
        const k = String(r.key);
        const row = map.get(k) || { key: k, events: 0, important: 0, summaries: 0, lastTs: 0 };
        row.summaries = Number(r.n) || 0;
        map.set(k, row);
      }
      return [...map.values()].sort((a, b) => b.lastTs - a.lastTs);
    },

    stats() {
      return {
        events: Number(q.countEvents.get()?.n) || 0,
        summaries: Number(q.countSummaries.get()?.n) || 0,
      };
    },

    close() {
      try { db.close(); } catch { /* ignore */ }
    },
  };
}

// 把一批消息压成一段「滚动摘要」文本：规则压缩，不依赖模型，稳定且便宜。
export function buildRollingSummary(rows, { maxLines = 40, lineChars = 90, maxChars = 1500 } = {}) {
  const items = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.kind === 'message' && String(r.text || '').trim())
    .slice(-maxLines);
  if (!items.length) return '';
  const lines = items.map((r) => {
    const who = r.importance >= 3 ? '【管理员】' : (r.sender || '未知');
    return `[${fmtClock(r.ts)}] ${who}：${clip(r.text, lineChars)}`;
  });
  let out = lines.join('\n');
  if (out.length > maxChars) out = out.slice(out.length - maxChars);
  return out;
}
