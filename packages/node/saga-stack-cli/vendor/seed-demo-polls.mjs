#!/usr/bin/env node
// ───────────────────────────────────────────────────────────────────────────
// seed-demo-polls.mjs — author a few OBVIOUS demo polls into a running
// content-api, so the dash picker + Connect show self-evidently-poll content
// (clear titles + question-bearing page labels + a visible canvas) instead of
// the background-only legacy slides.
//
// Pure content-api authoring — no saga_api, no migration, no fixtures. Mirrors
// the migrate tool's idempotency: GET /items/:ref → 404 ⇒ POST, 200 ⇒ PUT,
// then POST /publish. Safe to re-run (and to call from up.sh `seed_content`).
//
//   CONTENT_API=http://localhost:3009 IAM_SESSION=<jwt> node seed-demo-polls.mjs
//
// IAM_SESSION is REQUIRED against a content-api built after program-hub#570,
// which gates every REST write on a verified `iam_session` (cookie or bearer)
// and fails closed with no dev bypass. Same env var, same spelling, as
// content-api's own `tools/legacy-poll-migrate/migrate.ts`. Mint one with
// `ss stack login` and read it out of the cookie jar:
//
//   IAM_SESSION=$(awk '/iam_session/{print $7}' /tmp/sds-synthetic/cookies.txt)
// ───────────────────────────────────────────────────────────────────────────
const BASE = (process.env.CONTENT_API || 'http://localhost:3009').replace(/\/$/, '');
const IAM_SESSION = process.env.IAM_SESSION ?? '';

/** Headers for a WRITE leg. The read leg (GET) needs none — content-api's gate
 *  lets safe methods through — but sending the cookie there too is harmless and
 *  keeps one code path. Omitting the cookie entirely when unset preserves the
 *  pre-gate behaviour against an older content-api. */
function writeHeaders(hasBody = true) {
  return {
    ...(hasBody ? { 'content-type': 'application/json' } : {}),
    ...(IAM_SESSION ? { cookie: `iam_session=${IAM_SESSION}` } : {}),
  };
}

/** A 401 here is almost always "no session", not "bad payload" — say so, rather
 *  than making the reader diff a poll body against the schema. Mirrors the hint
 *  migrate.ts prints for the identical failure. */
async function writeFailed(verb, ref, res) {
  const body = await res.text();
  const hint =
    res.status === 401
      ? ` — content-api requires a verified iam_session on writes; ${
          IAM_SESSION ? 'the IAM_SESSION passed was rejected (expired?)' : 'set IAM_SESSION'
        } (mint one with \`ss stack login\`)`
      : '';
  return new Error(`${verb} ${ref} → ${res.status}: ${body}${hint}`);
}

/** One question → one page: grid background + a textbox carrying the prompt.
 *  `TextBoxElement.content` is what the qboard synthesizer renders (HTML-stripped);
 *  the question also rides in `label`, which Connect's page nav shows as Q1..Qn. */
function page(index, question) {
  return {
    index,
    label: `Q${index + 1} · ${question}`,
    canvas: {
      frame: { w: 1280, h: 720 },
      background: { kind: 'inline', name: 'GRAPH_PAPER' },
      objects: [
        { type: 'TextBoxElement', content: question, x: 80, y: 90, w: 1120, h: 160 },
      ],
    },
  };
}

const POLLS = [
  {
    ref: 'demo-poll-arithmetic',
    title: 'Demo · Quick Arithmetic Check',
    questions: ['What is 2 + 2?', 'What is 7 × 8?', 'Is 17 a prime number?'],
  },
  {
    ref: 'demo-poll-fractions',
    title: 'Demo · Fractions Warm-Up',
    questions: ['Which is larger: 1/2 or 1/3?', 'Simplify 4/8 to lowest terms.'],
  },
  {
    ref: 'demo-poll-exit-ticket',
    title: 'Demo · Exit Ticket',
    questions: ['In one sentence, what did you learn today?'],
  },
];

async function upsertAndPublish(p) {
  const body = { version: 0, pages: p.questions.map((q, i) => page(i, q)) };
  const payload = {
    ref: p.ref,
    kind: 'assessment',
    title: p.title,
    body,
    metadata: { contentType: 'POLL', source: 'demo-seed', authoredBy: 'synthetic-dev' },
  };

  const existing = await fetch(`${BASE}/content/items/${p.ref}`);
  let action;
  if (existing.status === 404) {
    const r = await fetch(`${BASE}/content/items`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw await writeFailed('POST', p.ref, r);
    action = 'created';
  } else if (existing.status === 200) {
    const r = await fetch(`${BASE}/content/items/${p.ref}`, {
      method: 'PUT',
      headers: writeHeaders(),
      body: JSON.stringify({ title: payload.title, body, metadata: payload.metadata }),
    });
    if (!r.ok) throw await writeFailed('PUT', p.ref, r);
    action = 'updated';
  } else {
    throw new Error(`GET ${p.ref} → unexpected ${existing.status}`);
  }

  const pub = await fetch(`${BASE}/content/items/${p.ref}/publish`, {
    method: 'POST',
    headers: writeHeaders(false),
  });
  if (!pub.ok) throw await writeFailed('publish', p.ref, pub);
  return `${action} + published  ${p.ref}  (${body.pages.length} pages)`;
}

const results = [];
for (const p of POLLS) results.push(await upsertAndPublish(p));
for (const line of results) console.log('  ✓', line);
console.log(`\n${results.length} demo polls seeded into ${BASE}`);
