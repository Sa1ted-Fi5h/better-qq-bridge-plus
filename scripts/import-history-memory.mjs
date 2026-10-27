// 一次性把现有 QQ 会话历史（state/social-v2.json 的 recentMessages）导入三层记忆库。
// 用法：node scripts/import-history-memory.mjs
import fs from 'node:fs';
import path from 'node:path';
import { openMemoryStore, buildRollingSummary } from '../src/memory-store.mjs';

const ROOT = process.cwd();
const svPath = path.join(ROOT, 'state/social-v2.json');
const dbPath = path.join(ROOT, 'state/memory.db');
const sv = JSON.parse(fs.readFileSync(svPath, 'utf8'));
const store = openMemoryStore({ dbPath });

const IMP_RE = /(重要|记住|决定|约定|生日|纪念|答应|以后都)/;
let added = 0;
let skipped = 0;

for (const [key, conv] of Object.entries(sv.conversations || {})) {
  const msgs = Array.isArray(conv.recentMessages) ? conv.recentMessages : [];
  if (!msgs.length) continue;
  const existing = new Set(
    store.window(key, 0, Number.MAX_SAFE_INTEGER, 100000).map((r) => Number(r.ts))
  );
  for (const m of msgs) {
    const ts = Number(m?.time) || 0;
    if (!ts) continue;
    if (existing.has(ts)) { skipped += 1; continue; }
    const text = String(m?.plain || m?.text || '').trim();
    if (!text) continue;
    const importance = m?.isOwner ? 3 : (m?.quoteTargetIsSelf ? 2 : (IMP_RE.test(text) ? 2 : 1));
    store.addEvent({
      key,
      ts,
      kind: 'message',
      sender: String(m?.sender || ''),
      userId: m?.userId,
      text,
      importance,
      source: 'history'
    });
    added += 1;
  }
}

console.log(`[import] 新增 ${added} 条，跳过 ${skipped} 条；当前`, store.stats());

// 把「5 分钟以前、每满 20 条」的历史压成滚动摘要（中期记忆）
const now = Date.now();
const keepRecentMs = 300000;
for (const key of store.allKeys()) {
  let cursor = store.getCursor(key);
  let made = 0;
  for (;;) {
    const rows = store.window(key, cursor, now - keepRecentMs, 20);
    if (rows.length < 20) break;
    const text = buildRollingSummary(rows);
    if (!text) break;
    const fromTs = Number(rows[0].ts) || cursor;
    const toTs = Number(rows[rows.length - 1].ts) || now;
    store.addSummary({ key, fromTs, toTs, text, msgCount: rows.length });
    store.setCursor(key, toTs);
    cursor = toTs;
    made += 1;
  }
  console.log(`[import] ${key} 生成摘要 ${made} 段`);
}

console.log('[import] 完成', store.stats());
store.close();
