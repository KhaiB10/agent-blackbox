# agent-blackbox

**A flight recorder for AI agents.** Put it between your agent and any OpenAI-compatible API — Ollama, llama.cpp, vLLM, OpenAI, DeepSeek — and every chat turn is recorded: the messages, the tools offered, the reply, the tool calls, timing and tokens. No code changes.

Then you can read what actually happened, replay a turn against another model, and **audit for actions the model claimed but never took**.

```bash
npm install -g github:KhaiB10/agent-blackbox
agent-blackbox record --upstream http://127.0.0.1:11434      # or https://api.openai.com
# point your agent at http://localhost:11436/v1 instead of the upstream
```

```
$ agent-blackbox list
0mun7vi5y681c  09-29 21:57:09  qwen3:8b    2530ms  Email Maria that the meeting moved to 3…  Subject: Meeting Moved to 3 PM Hi Maria, I just w…
0mun7w81dbe40  09-29 21:57:42  qwen3:8b   28998ms  Say hello in five words.                  Hello, how can I help you?

$ agent-blackbox audit
0mun7vi5y681c  qwen3:8b  claimed  "I've sent"   (asked: Email Maria that the meeting moved to 3pm, then c…)
1 unbacked claim(s) in 5 recorded turn(s). Inspect one with: agent-blackbox show ID
```

## Commands

| | |
|---|---|
| `record --upstream URL [--port 11436]` | the recording proxy. Streams pass through byte for byte; the recording is assembled on the side |
| `list [--last 20] [--model M]` | one line per turn: time, model, latency, what was asked, what came back |
| `show ID` | the whole turn: system prompt, messages, tools offered, reasoning, reply, tool calls, audit flags |
| `audit [--last N]` | turns where the reply **claims an action** ("I've sent…", "I created the issue…") or **promises one and stops** ("I'll send it now"), with no tool call behind it. Exit code 1 if any |
| `replay ID [--model M] [--upstream URL]` | re-send a recorded request, show the recorded and new replies side by side |
| `stats` | per model: turns, average latency, turns with tool calls, errors, flagged claims |

IDs can be shortened to their last few characters.

## What the audit is — and isn't

A claimed action that never happened is the worst thing an agent does: "Done, I sent it" reads as fine until you find out it didn't. The audit uses [says-vs-does](https://github.com/KhaiB10/says-vs-does)' first-person claim patterns (save, schedule, remind, delete, send, create, update). A claim counts as backed if the reply made a tool call, or if a tool ran earlier in the same turn (so "I've created ANC-11" after a real `create_issue` result is fine).

It is a **tripwire that points you at turns worth reading, not a judge.** Real example from the test above, where a model with *no email tool* was asked to email someone and confirm: four replies drafted the email. The one flagged ("P.S. Just confirming that I've sent this update") is text *inside the drafted email*, so it's debatable. Two others said "I've updated the meeting time", also inside the draft, and were not flagged, because the patterns only count "updated" next to words like *file* or *record*, to keep false alarms down. The audit can't tell the assistant's own voice from text it is drafting. `show` the turn and decide.

## Privacy

- API keys and auth headers are **forwarded to the upstream but never written** to disk.
- Prompts and replies **are** written: `~/.agent-blackbox/YYYY-MM-DD.jsonl`, created private to your user (mode 600). Move it with `AGENT_BLACKBOX_DIR`. They are plain JSON lines — `grep` works.
- It listens on `127.0.0.1` by default and has no authentication of its own.

`replay` sends the recorded messages to the upstream again. For a remote upstream it adds `OPENAI_API_KEY` from your environment if set.

## Scope

Records `POST …/chat/completions` (OpenAI format, streaming and not). Every other path passes through unrecorded. Ollama's native `/api/chat` is not recorded — use its `/v1` endpoint (or [ollama-guard](https://github.com/KhaiB10/ollama-guard), which speaks `/v1` and gives you a working `num_ctx`; the two chain fine).

## Test

```bash
npm test
```

9 tests, including the proxy end to end over real HTTP with a streaming and a non-streaming upstream, and a check that keys never reach the recording.

## License

MIT
