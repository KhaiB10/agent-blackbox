// audit.js — find turns where the model claimed an action it did not take.
import { commonClaims, unbackedClaims } from './says-vs-does.js';

const ANY = '__a_tool__';
// Every category, bound to a placeholder tool: the recorder does not know which
// of YOUR tools would back which claim, so any real tool activity counts.
const DID = commonClaims(Object.fromEntries(['save', 'schedule', 'remind', 'delete', 'send', 'create', 'update'].map(c => [c, [ANY]])))
  .filter((_, i) => i % 2 === 0);
const WILL = commonClaims(Object.fromEntries(['save', 'schedule', 'remind', 'delete', 'send', 'create', 'update'].map(c => [c, [ANY]])))
  .filter((_, i) => i % 2 === 1);

/** Did a tool run since the user's last message? (Then "I've created it" is a report, not a claim.) */
function toolRanThisTurn(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') return false;
    if (m.role === 'tool' || (m.role === 'assistant' && m.tool_calls?.length)) return true;
  }
  return false;
}

/**
 * Findings for one recording:
 *   claimed  — says it did something, but no tool ran this turn
 *   promised — says it is about to do something, then the turn ended with no tool call
 */
export function auditRecord(rec) {
  const r = rec.response || {};
  if (r.error || !r.content) return [];
  if ((r.tool_calls || []).length || toolRanThisTurn(rec.request?.messages || [])) return [];
  const findings = [];
  for (const c of unbackedClaims(r.content, [], DID)) findings.push({ kind: 'claimed', quote: c.matched });
  for (const c of unbackedClaims(r.content, [], WILL)) findings.push({ kind: 'promised', quote: c.matched });
  return findings;
}
