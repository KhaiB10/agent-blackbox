import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-'));
process.env.AGENT_BLACKBOX_DIR = tmp;
const { createRecorder, StreamAssembler } = await import('../src/recorder.js');
const { all, find, safeHeaders } = await import('../src/store.js');
const { auditRecord } = await import('../src/audit.js');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('StreamAssembler', () => {
  test('rebuilds content, reasoning and tool calls split across chunks', () => {
    const a = new StreamAssembler();
    const ev = (o) => `data: ${JSON.stringify(o)}\n\n`;
    const s = ev({ model: 'm', choices: [{ delta: { role: 'assistant', content: 'Let me ' } }] })
      + ev({ choices: [{ delta: { content: 'check.', reasoning: 'think' } }] })
      + ev({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'bash', arguments: '{"comm' } }] } }] })
      + ev({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] }, finish_reason: 'tool_calls' }] })
      + ev({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } }) + 'data: [DONE]\n\n';
    a.push(s.slice(0, 37)); a.push(s.slice(37));   // split mid-event
    const r = a.result();
    assert.equal(r.content, 'Let me check.');
    assert.equal(r.reasoning, 'think');
    assert.deepEqual(r.tool_calls[0].function, { name: 'bash', arguments: '{"command":"ls"}' });
    assert.equal(r.finish_reason, 'tool_calls');
    assert.equal(r.usage.prompt_tokens, 5);
  });
});

describe('audit', () => {
  const rec = (content, messages = [{ role: 'user', content: 'do it' }], tool_calls = []) => ({ request: { messages }, response: { content, tool_calls } });
  test('a claimed action with no tool call is flagged', () => {
    assert.equal(auditRecord(rec("Done — I've created the issue ANC-11 for you."))[0].kind, 'claimed');
    assert.equal(auditRecord(rec('I have just sent the email to Maria.'))[0].kind, 'claimed');
  });
  test('a promise that ends the turn is flagged separately', () => {
    assert.equal(auditRecord(rec("Sure, I'll send the report now."))[0].kind, 'promised');
  });
  test('a report after a real tool call is not a claim', () => {
    const msgs = [{ role: 'user', content: 'make an issue' }, { role: 'assistant', content: '', tool_calls: [{ id: 'c', function: { name: 'create_issue', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c', content: 'ANC-11' }];
    assert.deepEqual(auditRecord(rec("I've created the issue ANC-11.", msgs)), []);
    assert.deepEqual(auditRecord(rec("I've created the issue.", undefined, [{ function: { name: 'create_issue' } }])), []);
  });
  test('ordinary answers are not flagged', () => {
    assert.deepEqual(auditRecord(rec('You could create an issue for that in the tracker.')), []);
    assert.deepEqual(auditRecord(rec('The capital of France is Paris.')), []);
  });
});

describe('store', () => {
  test('auth headers are never kept', () => {
    assert.deepEqual(safeHeaders({ authorization: 'Bearer sk-x', 'x-api-key': 'k', 'user-agent': 'ua' }), { 'user-agent': 'ua' });
  });
});

describe('recorder end to end', () => {
  let up, rec, base, gotAuth;
  before(async () => {
    up = http.createServer(async (req, res) => {
      let b = ''; for await (const c of req) b += c;
      gotAuth = req.headers.authorization;
      const body = b ? JSON.parse(b) : {};
      if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[]}'); }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ model: 'm', choices: [{ delta: { content: "I've sent the email." }, finish_reason: 'stop' }] })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'm', choices: [{ message: { role: 'assistant', content: 'ok', tool_calls: [{ id: 'c', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 9, completion_tokens: 2 } }));
    });
    await new Promise(r => up.listen(0, '127.0.0.1', r));
    rec = createRecorder({ upstream: `http://127.0.0.1:${up.address().port}` });
    await new Promise(r => rec.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${rec.address().port}`;
  });
  after(() => { up.close(); rec.close(); });

  test('non-streaming: client gets the upstream reply; the recording has the call and no key', async () => {
    const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sk-secret' },
      body: JSON.stringify({ model: 'm', temperature: 0.2, messages: [{ role: 'user', content: 'list files' }], tools: [{ type: 'function', function: { name: 'bash' } }] }) });
    const j = await r.json();
    assert.equal(j.choices[0].message.tool_calls[0].function.name, 'bash');
    assert.equal(gotAuth, 'Bearer sk-secret', 'auth still reaches the upstream');
    await new Promise(r => setTimeout(r, 50));
    const saved = [...all()].at(-1);
    assert.equal(saved.response.tool_calls[0].function.name, 'bash');
    assert.deepEqual(saved.params, { temperature: 0.2 });
    assert.equal(JSON.stringify(saved).includes('sk-secret'), false);
    assert.ok(find(saved.id.slice(-6)));
  });

  test('streaming: bytes pass through unchanged, and the audit catches the claim', async () => {
    const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'email maria' }] }) });
    const t = await r.text();
    assert.ok(t.includes("I've sent the email.") && t.trim().endsWith('data: [DONE]'));
    await new Promise(r => setTimeout(r, 50));
    const saved = [...all()].at(-1);
    assert.equal(saved.response.content, "I've sent the email.");
    assert.equal(auditRecord(saved)[0].kind, 'claimed');
  });

  test('other endpoints pass through and are not recorded', async () => {
    const before = [...all()].length;
    assert.deepEqual(await (await fetch(`${base}/v1/models`)).json(), { data: [] });
    assert.equal([...all()].length, before);
  });
});
