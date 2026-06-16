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
//   CONTENT_API=http://localhost:3009 node seed-demo-polls.mjs
// ───────────────────────────────────────────────────────────────────────────
const BASE = (process.env.CONTENT_API || 'http://localhost:3009').replace(/\/$/, '');

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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`POST ${p.ref} → ${r.status}: ${await r.text()}`);
    action = 'created';
  } else if (existing.status === 200) {
    const r = await fetch(`${BASE}/content/items/${p.ref}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: payload.title, body, metadata: payload.metadata }),
    });
    if (!r.ok) throw new Error(`PUT ${p.ref} → ${r.status}: ${await r.text()}`);
    action = 'updated';
  } else {
    throw new Error(`GET ${p.ref} → unexpected ${existing.status}`);
  }

  const pub = await fetch(`${BASE}/content/items/${p.ref}/publish`, { method: 'POST' });
  if (!pub.ok) throw new Error(`publish ${p.ref} → ${pub.status}: ${await pub.text()}`);
  return `${action} + published  ${p.ref}  (${body.pages.length} pages)`;
}

const results = [];
for (const p of POLLS) results.push(await upsertAndPublish(p));
for (const line of results) console.log('  ✓', line);
console.log(`\n${results.length} demo polls seeded into ${BASE}`);
