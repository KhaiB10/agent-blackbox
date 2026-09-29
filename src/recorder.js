// recorder.js — a pass-through proxy that records OpenAI-compatible chat traffic.
// Clients see exactly what the upstream sent (streams are forwarded byte for
// byte); the recording is assembled on the side.
import http from 'node:http';
import { append, newId, safeHeaders } from './store.js';

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'host', 'upgrade']);
const PARAMS = ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'seed', 'stop', 'tool_choice', 'response_format', 'reasoning_effort'];

/** Rebuild the final assistant message from OpenAI SSE `data:` payloads. */
export class StreamAssembler {
  constructor() { this.content = ''; this.reasoning = ''; this.calls = []; this.finish = null; this.usage = null; this.model = null; this.buf = ''; }
  push(text) {
    this.buf += text;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let j; try { j = JSON.parse(data); } catch { continue; }
      this.model ||= j.model;
      if (j.usage) this.usage = j.usage;
      const ch = j.choices?.[0];
      if (!ch) continue;
      const d = ch.delta || {};
      if (d.content) this.content += d.content;
      if (d.reasoning) this.reasoning += d.reasoning;
      if (d.reasoning_content) this.reasoning += d.reasoning_content;
      for (const tc of d.tool_calls || []) {
        const idx = tc.index ?? this.calls.length;
        const cur = (this.calls[idx] ||= { id: tc.id, type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.function.name += tc.function.name;
        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
      }
      if (ch.finish_reason) this.finish = ch.finish_reason;
    }
  }
  result() {
    return { content: this.content, ...(this.reasoning ? { reasoning: this.reasoning } : {}),
      tool_calls: this.calls.filter(Boolean), finish_reason: this.finish, usage: this.usage };
  }
}

function fromCompletion(j) {
  const ch = j?.choices?.[0] || {};
  const m = ch.message || {};
  return { content: m.content ?? '', ...(m.reasoning || m.reasoning_content ? { reasoning: m.reasoning || m.reasoning_content } : {}),
    tool_calls: m.tool_calls || [], finish_reason: ch.finish_reason ?? null, usage: j?.usage ?? null };
}

export function createRecorder({ upstream, onRecord = append } = {}) {
  if (!upstream) throw new Error('upstream is required, e.g. http://127.0.0.1:11434');
  return http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, upstream);
    const isChat = req.method === 'POST' && /\/chat\/completions$/.test(url.pathname);
    let body = null;
    if (isChat) { try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; } }

    const headers = {}; for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
    const t0 = Date.now();
    let up;
    try {
      up = await fetch(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw, duplex: 'half' });
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `agent-blackbox: upstream unreachable: ${e.message}` } }));
      return;
    }
    const out = {}; up.headers.forEach((v, k) => { if (!HOP.has(k)) out[k] = v; });
    res.writeHead(up.status, out);

    const streaming = /text\/event-stream/.test(up.headers.get('content-type') || '');
    const asm = streaming ? new StreamAssembler() : null;
    const dec = new TextDecoder();
    const kept = [];
    if (up.body) {
      for await (const chunk of up.body) {
        res.write(chunk);
        if (!isChat || !body) continue;
        if (asm) asm.push(dec.decode(chunk, { stream: true })); else kept.push(Buffer.from(chunk));
      }
    }
    res.end();
    if (!isChat || !body) return;

    let response;
    if (up.status >= 400) {
      response = { error: Buffer.concat(kept).toString('utf8').slice(0, 2000) || `HTTP ${up.status}` };
    } else if (asm) response = asm.result();
    else { try { response = fromCompletion(JSON.parse(Buffer.concat(kept).toString('utf8'))); } catch { response = { error: 'unparseable response' }; } }

    const params = {}; for (const p of PARAMS) if (body[p] !== undefined) params[p] = body[p];
    const rec = {
      id: newId(t0), ts: new Date(t0).toISOString(), ms: Date.now() - t0,
      upstream: url.origin, path: url.pathname, status: up.status,
      model: body.model, stream: !!body.stream, params,
      request: { messages: body.messages || [], tools: body.tools || [] },
      request_headers: safeHeaders({ 'user-agent': req.headers['user-agent'] }),
      response,
    };
    try { onRecord(rec); } catch (e) { console.error(`[agent-blackbox] could not write recording: ${e.message}`); }
  });
}
