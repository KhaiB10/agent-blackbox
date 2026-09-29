#!/usr/bin/env node
import { createRecorder } from '../src/recorder.js';
import { all, find, dir } from '../src/store.js';
import { auditRecord } from '../src/audit.js';

const HELP = `agent-blackbox — a flight recorder for AI agents.

  agent-blackbox record --upstream URL [--port 11436] [--host 127.0.0.1]
        Proxy that records every /chat/completions exchange. Point your agent at
        http://localhost:11436 (keep the /v1 path your client already uses).
  agent-blackbox list   [--last 20] [--model NAME]
  agent-blackbox show   ID
  agent-blackbox audit  [--last N]        turns that claimed an action no tool performed
  agent-blackbox replay ID [--model NAME] [--upstream URL]
  agent-blackbox stats

Recordings: ${dir()}  (JSON lines, one file per day; set AGENT_BLACKBOX_DIR to move them).
API keys and auth headers are never written. Prompts and replies are — keep the folder private.`;

function flags(argv) {
  const f = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { f._.push(a); continue; }
    const k = a.slice(2);
    if (argv[i + 1] && !argv[i + 1].startsWith('--')) f[k] = argv[++i]; else f[k] = true;
  }
  return f;
}

const short = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const lastUser = (msgs) => [...msgs].reverse().find(m => m.role === 'user');
const text = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => p.text || `[${p.type}]`).join(' ') : '';
const callsOf = (r) => (r.response?.tool_calls || []).map(t => t.function?.name).filter(Boolean);

function recent(f) {
  let rs = [...all()];
  if (f.model) rs = rs.filter(r => r.model === f.model);
  return rs.slice(-(Number(f.last) || 20));
}

const [cmd, ...rest] = process.argv.slice(2);
const f = flags(rest);

if (cmd === 'record') {
  const upstream = f.upstream || process.env.AGENT_BLACKBOX_UPSTREAM;
  if (!upstream) { console.error('need --upstream, e.g. --upstream http://127.0.0.1:11434 or https://api.openai.com'); process.exit(2); }
  const port = Number(f.port || 11436), host = f.host || '127.0.0.1';
  createRecorder({ upstream }).listen(port, host, () => console.log(`agent-blackbox recording on http://${host}:${port}  ->  ${upstream}\nrecordings: ${dir()}`));
} else if (cmd === 'list') {
  for (const r of recent(f)) {
    const calls = callsOf(r);
    const out = r.response?.error ? `ERROR ${short(r.response.error, 40)}` : calls.length ? `→ ${calls.join(', ')}` : short(r.response?.content, 50);
    console.log(`${r.id}  ${r.ts.slice(5, 19).replace('T', ' ')}  ${short(r.model, 22).padEnd(22)} ${String(r.ms).padStart(6)}ms  ${short(text(lastUser(r.request.messages)?.content), 40).padEnd(40)}  ${out}`);
  }
} else if (cmd === 'show') {
  const r = find(f._[0] || '');
  if (!r) { console.error('no such recording'); process.exit(1); }
  console.log(`${r.id}  ${r.ts}  ${r.model}  ${r.ms} ms  ${r.upstream}${r.path}  status ${r.status}  ${JSON.stringify(r.params)}`);
  if (r.request.tools.length) console.log(`tools offered: ${r.request.tools.map(t => t.function?.name).join(', ')}`);
  console.log('');
  for (const m of r.request.messages) {
    const calls = (m.tool_calls || []).map(t => `${t.function?.name}(${short(t.function?.arguments, 80)})`).join('; ');
    console.log(`── ${m.role}${m.tool_call_id ? ` (${m.tool_call_id})` : ''}${calls ? `  calls: ${calls}` : ''}`);
    const t = text(m.content); if (t) console.log(short(t, m.role === 'system' ? 300 : 2000));
  }
  const res = r.response;
  console.log(`\n══ reply  (finish: ${res.finish_reason ?? '-'}${res.usage ? `, ${res.usage.prompt_tokens} in / ${res.usage.completion_tokens} out` : ''})`);
  if (res.error) console.log(`ERROR: ${res.error}`);
  if (res.reasoning) console.log(`[reasoning] ${short(res.reasoning, 600)}`);
  if (res.content) console.log(res.content);
  for (const t of res.tool_calls || []) console.log(`→ ${t.function?.name}(${t.function?.arguments})`);
  for (const x of auditRecord(r)) console.log(`\n⚠ ${x.kind}: "${x.quote}" — no tool ran this turn`);
} else if (cmd === 'audit') {
  let n = 0, seen = 0;
  const rs = f.last ? recent(f) : [...all()];
  for (const r of rs) {
    seen++;
    for (const x of auditRecord(r)) {
      n++;
      console.log(`${r.id}  ${r.model}  ${x.kind.padEnd(8)} "${x.quote}"   (asked: ${short(text(lastUser(r.request.messages)?.content), 50)})`);
    }
  }
  console.log(`\n${n} unbacked claim(s) in ${seen} recorded turn(s).${n ? ' Inspect one with: agent-blackbox show ID' : ''}`);
  process.exitCode = n ? 1 : 0;
} else if (cmd === 'replay') {
  const r = find(f._[0] || '');
  if (!r) { console.error('no such recording'); process.exit(1); }
  const upstream = f.upstream || r.upstream;
  const model = f.model || r.model;
  const body = { model, messages: r.request.messages, ...(r.request.tools.length ? { tools: r.request.tools } : {}), ...r.params, stream: false };
  const headers = { 'content-type': 'application/json' };
  if (process.env.OPENAI_API_KEY && !/127\.0\.0\.1|localhost/.test(upstream)) headers.authorization = `Bearer ${process.env.OPENAI_API_KEY}`;
  const t0 = Date.now();
  const res = await fetch(new URL(r.path, upstream), { method: 'POST', headers, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  const m = j.choices?.[0]?.message || {};
  const show = (label, mdl, content, calls, ms) => {
    console.log(`── ${label}: ${mdl}${ms != null ? `  (${ms} ms)` : ''}`);
    if (content) console.log(short(content, 1500));
    for (const c of calls || []) console.log(`→ ${c.function?.name}(${c.function?.arguments})`);
  };
  show('recorded', r.model, r.response.content, r.response.tool_calls, r.ms);
  console.log('');
  if (!res.ok) console.log(`── replay failed: HTTP ${res.status} ${JSON.stringify(j).slice(0, 300)}`);
  else show('replay', model, m.content, m.tool_calls, Date.now() - t0);
} else if (cmd === 'stats') {
  const by = new Map(); let flagged = 0, total = 0;
  for (const r of all()) {
    total++;
    const s = by.get(r.model) || { n: 0, ms: 0, calls: 0, errors: 0, claims: 0 };
    s.n++; s.ms += r.ms || 0; s.calls += callsOf(r).length ? 1 : 0; s.errors += r.response?.error ? 1 : 0;
    const a = auditRecord(r).length; s.claims += a ? 1 : 0; flagged += a ? 1 : 0;
    by.set(r.model, s);
  }
  console.log(`${total} recorded turn(s), ${flagged} with unbacked claims\n`);
  console.log(`${'model'.padEnd(30)} ${'turns'.padStart(6)} ${'avg ms'.padStart(8)} ${'w/ tools'.padStart(9)} ${'errors'.padStart(7)} ${'claims'.padStart(7)}`);
  for (const [m, s] of by) console.log(`${short(m, 30).padEnd(30)} ${String(s.n).padStart(6)} ${String(Math.round(s.ms / s.n)).padStart(8)} ${String(s.calls).padStart(9)} ${String(s.errors).padStart(7)} ${String(s.claims).padStart(7)}`);
} else {
  console.log(HELP);
  process.exitCode = cmd && !['help', '--help', '-h'].includes(cmd) ? 2 : 0;
}
