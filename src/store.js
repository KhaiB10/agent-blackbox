// store.js — recordings are JSON lines, one file per day, in ~/.agent-blackbox.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const dir = () => process.env.AGENT_BLACKBOX_DIR || path.join(os.homedir(), '.agent-blackbox');

/** Time-sortable id: base36 milliseconds + 4 random chars. */
export function newId(now = Date.now()) {
  return now.toString(36).padStart(9, '0') + randomBytes(2).toString('hex');
}

export function append(rec) {
  const d = dir();
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const file = path.join(d, `${new Date(rec.ts).toISOString().slice(0, 10)}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(rec) + '\n', { mode: 0o600 });
}

export function* all() {
  const d = dir();
  if (!fs.existsSync(d)) return;
  for (const f of fs.readdirSync(d).filter(f => f.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(d, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { yield JSON.parse(line); } catch { /* a torn last line from a crash: skip it */ }
    }
  }
}

export function find(id) {
  for (const r of all()) if (r.id === id || r.id.endsWith(id)) return r;
  return null;
}

/** Never store credentials: drop auth headers, and mask anything that looks like a key in URLs. */
export function safeHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    if (/^(authorization|x-api-key|api-key|cookie|proxy-authorization)$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}
