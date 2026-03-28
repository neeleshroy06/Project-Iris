/**
 * Long-term session memory: JSON file in app.getPath('userData') (not the repo).
 * Survives `npm start` restarts; removed with app uninstall / clearing Iris app data.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const STORE_VERSION = 1;
const MAX_PROFILE_CHARS = 12000;
const MAX_TURN_CHARS = 4000;
const MAX_PENDING_TURNS = 32;
const AUTO_CONSOLIDATE_AFTER_TURNS = 6;

const MODEL =
  (process.env.GEMINI_MEMORY_MODEL || 'gemini-2.5-flash-lite').trim() || 'gemini-2.5-flash-lite';

/** @type {{ version: number, profileText: string, pendingTurns: { role: string, text: string, at: number }[], updatedAt: number } | null} */
let cache = null;

function storePath() {
  return path.join(app.getPath('userData'), 'iris-memory.json');
}

function defaultStore() {
  return {
    version: STORE_VERSION,
    profileText: '',
    pendingTurns: [],
    updatedAt: Date.now(),
  };
}

function load() {
  if (cache) return cache;
  const p = storePath();
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') {
      cache = {
        version: typeof data.version === 'number' ? data.version : STORE_VERSION,
        profileText: typeof data.profileText === 'string' ? data.profileText : '',
        pendingTurns: Array.isArray(data.pendingTurns) ? data.pendingTurns : [],
        updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : Date.now(),
      };
      if (cache.profileText.length > MAX_PROFILE_CHARS) {
        cache.profileText = cache.profileText.slice(-MAX_PROFILE_CHARS);
      }
      return cache;
    }
  } catch {
    /* missing or corrupt */
  }
  cache = defaultStore();
  return cache;
}

function save() {
  const data = load();
  data.updatedAt = Date.now();
  const p = storePath();
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, p);
}

function getProfileText() {
  const t = load().profileText.trim();
  return t.length > MAX_PROFILE_CHARS ? t.slice(-MAX_PROFILE_CHARS) : t;
}

function appendTurn(payload) {
  const role = payload?.role === 'assistant' ? 'assistant' : 'user';
  let text = typeof payload?.text === 'string' ? payload.text.trim() : '';
  if (text.length < 3) return;
  if (text.length > MAX_TURN_CHARS) text = `${text.slice(0, MAX_TURN_CHARS)}…`;
  const data = load();
  data.pendingTurns.push({ role, text, at: Date.now() });
  while (data.pendingTurns.length > MAX_PENDING_TURNS) {
    data.pendingTurns.shift();
  }
  save();
}

function pendingCount() {
  return load().pendingTurns.length;
}

let consolidateTimer = null;

function scheduleAutoConsolidate(apiKey) {
  if (!apiKey || !String(apiKey).trim()) return;
  if (pendingCount() < AUTO_CONSOLIDATE_AFTER_TURNS) return;
  if (consolidateTimer) clearTimeout(consolidateTimer);
  consolidateTimer = setTimeout(() => {
    consolidateTimer = null;
    consolidate(apiKey).catch(() => {});
  }, 2500);
}

/**
 * Merge pending turns into profileText via Gemini REST.
 * @param {string} apiKey
 */
async function consolidate(apiKey) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) return;

  const data = load();
  const pending = data.pendingTurns;
  if (!pending.length) return;

  const turnsBlock = pending
    .map((t) => `${t.role === 'assistant' ? 'Assistant' : 'User'}: ${t.text}`)
    .join('\n');

  const prior = data.profileText.trim() || '(none yet)';

  const prompt = `You maintain a concise long-term memory about a user talking to their desktop assistant "Iris".

Existing memory summary (may be empty):
---
${prior.slice(-8000)}
---

New conversation turns to fold in:
---
${turnsBlock.slice(-12000)}
---

Write an UPDATED memory summary in plain text (no JSON, no markdown headings required). Include:
- Topics, projects, or goals they care about
- Communication preferences (verbosity, tone, things they asked you to do or avoid)
- Stable facts they want remembered (names, tools, constraints) when clearly stated

Keep it under 900 words. If nothing worth retaining, output a short paragraph or "No durable preferences noted yet."`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.35,
      maxOutputTokens: 2048,
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Gemini memory (${MODEL}): ${res.status} ${raw.slice(0, 400)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON from Gemini memory API');
  }

  const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text || typeof text !== 'string') {
    throw new Error('No memory text from Gemini');
  }

  let next = text.trim();
  if (next.length > MAX_PROFILE_CHARS) {
    next = next.slice(-MAX_PROFILE_CHARS);
  }

  data.profileText = next;
  data.pendingTurns = [];
  save();
}

function cancelAutoConsolidateTimer() {
  if (consolidateTimer) {
    clearTimeout(consolidateTimer);
    consolidateTimer = null;
  }
}

module.exports = {
  getProfileText,
  appendTurn,
  pendingCount,
  consolidate,
  scheduleAutoConsolidate,
  cancelAutoConsolidateTimer,
};
