// Vendored from says-vs-does (MIT, same author): https://github.com/KhaiB10/says-vs-does
/**
 * says-vs-does — catch an LLM agent claiming it did something it did not do.
 *
 * The failure, observed in production: asked to record a prediction, the agent
 * replied "The prediction ID is 15." It called no tools at all. There is no
 * prediction 15. It invented a tool result and reported it as fact.
 *
 * This is the worst failure mode an agent has, because users ACT on what it
 * says — "I saved that", "I set the reminder", "I sent the email". A wrong
 * answer they can catch. A fabricated action they cannot: nothing looks broken
 * until the thing they were counting on turns out never to have existed.
 *
 * Sharpening the prompt does not fix it (tried; it got worse). So instead of
 * asking the model to behave, CHECK: match every reply against the tools that
 * actually ran this turn, and catch any claim with no matching call.
 *
 * Pure and synchronous — cheap enough to run on every single turn, and
 * testable enough to trust.
 */

// Adverbs defeat patterns one at a time: "I've JUST saved" matches, "I've NOW
// saved" doesn't, and the lie goes out. Strip the filler once instead of
// widening every regex forever.
const FILLER = /\b(just|now|already|then|successfully|finally|go ahead and)\s+/gi;

// "I did X" — past-tense, first-person, completed.
const DID = "i(?:'ve| have)?\\s+";
// "I'm about to do X" — a promise at the end of a turn that then ended.
const WILL = "(?:i(?:'ll| will)|let me|i(?:'m| am) going to|i shall)\\s+";

/**
 * The claim categories most agents share. Each entry produces one "I did X"
 * pattern and one "I'll do X" pattern, bound to whatever YOUR tools are named.
 *
 * Deliberately narrow. Only first-person assertions match: "I saved that" is a
 * claim, "you could save that" is not. A false positive forces a pointless
 * retry, so precision beats reach.
 */
const CATEGORIES = {
  save:     { did: `${DID}(?:saved|stored|remembered|noted|committed|logged|recorded)\\b[^.!?]{0,30}\\b(?:that|this|it|to memory|in memory)\\b`,
              will: `${WILL}(?:save|store|remember|note|commit|log|record)\\b[^.!?]{0,30}\\b(?:that|this|it|to memory|in memory)\\b` },
  schedule: { did: `${DID}scheduled\\b`,
              will: `${WILL}schedule\\b` },
  remind:   { did: `${DID}(?:set|created|added)\\b[^.!?]{0,20}\\breminder\\b`,
              will: `${WILL}(?:set|create|add)\\b[^.!?]{0,20}\\breminder\\b` },
  delete:   { did: `${DID}(?:forgotten|deleted|removed|cleared)\\b[^.!?]{0,30}\\b(?:that|this|it|memory|fact|file|entry)\\b`,
              will: `${WILL}(?:forget|delete|remove|clear)\\b[^.!?]{0,30}\\b(?:that|this|it|memory|fact|file|entry)\\b` },
  send:     { did: `${DID}(?:sent|emailed|messaged|posted|forwarded)\\b`,
              will: `${WILL}(?:send|email|message|post|forward)\\b` },
  create:   { did: `${DID}(?:created|built|added|generated)\\b[^.!?]{0,25}\\b(?:file|document|task|entry|record|ticket|issue)\\b`,
              will: `${WILL}(?:create|build|add|generate)\\b[^.!?]{0,25}\\b(?:file|document|task|entry|record|ticket|issue)\\b` },
  update:   { did: `${DID}(?:updated|edited|changed|modified)\\b[^.!?]{0,25}\\b(?:file|record|entry|settings?|config)\\b`,
              will: `${WILL}(?:update|edit|change|modify)\\b[^.!?]{0,25}\\b(?:file|record|entry|settings?|config)\\b` },
};

/**
 * Build a claim registry from category names mapped to YOUR tool names.
 *
 *   commonClaims({ save: ['remember_fact'], send: ['send_email', 'send_slack'] })
 *
 * A category maps to the tools that would have had to run for the claim to be
 * true — if ANY of them ran this turn, the claim is backed.
 */
export function commonClaims(map) {
  const out = [];
  for (const [cat, tools] of Object.entries(map || {})) {
    const c = CATEGORIES[cat];
    if (!c) throw new Error(`unknown category "${cat}" — have: ${Object.keys(CATEGORIES).join(', ')}`);
    const list = Array.isArray(tools) ? tools : [tools];
    out.push({ tools: list, re: new RegExp(`\\b${c.did}`, 'i') });
    out.push({ tools: list, re: new RegExp(`\\b${c.will}`, 'i') });
  }
  return out;
}

/** Escape hatch: a custom claim — your own regex bound to your own tools. */
export function claim(tools, re) {
  return { tools: Array.isArray(tools) ? tools : [tools], re };
}

/**
 * Claims in `text` that no tool call backs up.
 *
 * @param {string}   text        the reply about to be sent to the user
 * @param {string[]} toolsCalled names of tools that actually ran this turn
 * @param {Array}    claims      registry from commonClaims()/claim()
 * @returns {{tools: string[], matched: string}[]} empty when the reply is honest
 */
export function unbackedClaims(text, toolsCalled = [], claims = []) {
  if (!text || !claims.length) return [];
  const ran = new Set(toolsCalled);
  const cleaned = String(text).replace(FILLER, '');
  const out = [];
  for (const { tools, re } of claims) {
    if (tools.some(t => ran.has(t))) continue;        // something backs it up
    const m = re.exec(cleaned);
    if (m) out.push({ tools, matched: m[0].slice(0, 80) });
  }
  return out;
}

/**
 * The corrective message to send back to the model on a caught fabrication.
 * States the specific lie rather than scolding generally — a vague "be honest"
 * nudge produces more confabulation, not less.
 */
export function correctionFor(claims) {
  const wanted = [...new Set(claims.flatMap(c => c.tools))].join(' or ');
  const said = claims.map(c => `"${c.matched}"`).join(', ');
  return `STOP. You just told the user ${said}, but you did NOT call ${wanted} — so it did not happen, and any id or result you quoted was invented. `
       + `Do it properly now: call ${wanted} for real, then report ONLY what the tool actually returned. `
       + `If the tool is not available to you this turn, say plainly that you could not do it. Never state an outcome you did not receive from a tool.`;
}

export default { unbackedClaims, correctionFor, commonClaims, claim };
