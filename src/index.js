// The Intervention Pledge Worker: serves public/ and the JSON API.
//
// Free-tier D1 queries fail for the rest of the day once the account passes its
// daily limits, so every public read goes through the Cache API, and the home
// page still renders (with the last known count) when D1 is unavailable.

import {
  REF_RE, TOKEN_RE, validateSignature, normalizeEmail, isEmail, newRefCode, newToken,
  maskEmail, timeAgo, toCSV, sha256Hex, safeEqual, summarize, escapeHTML
} from './lib.js';

const COUNT_TTL = 45;      // seconds
const WALL_TTL = 45;
const REF_TTL = 300;
const STALE_TTL = 7 * 24 * 3600;
const WALL_PAGE = 48;
const PAUSED = 'Signing is paused, please try again later.';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/admin' || path.startsWith('/admin/') || path.startsWith('/api/admin/')) {
        const denied = await requireAdmin(request, env);
        if (denied) return denied;
        return path.startsWith('/api/') ? await adminApi(request, env, ctx, url) : env.ASSETS.fetch(request);
      }
      if (path.startsWith('/api/')) return await publicApi(request, env, ctx, url);
      if (path === '/followup') return await followup(request, env, url);
      if (path === '/') return await homePage(request, env, ctx, url);
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return json({ error: 'Something went wrong. Please try again.' }, 500);
    }
  }
};

// ---------- responses ----------

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
  });
}

const notFound = () => json({ error: 'Not found.' }, 404);

async function readJSON(request) {
  const text = await request.text();
  if (text.length > 4096) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// ---------- cache ----------

// Fresh copies expire after `ttl`; stale copies are kept for a week so the site
// can still show something when D1 is over its daily limit.
async function cached(ctx, origin, key, ttl, produce) {
  const cache = caches.default;
  const fresh = new Request(`${origin}/__cache/fresh/${key}`);
  const stale = new Request(`${origin}/__cache/stale/${key}`);
  const hit = await cache.match(fresh);
  if (hit) return hit.json();
  try {
    const data = await produce();
    const body = JSON.stringify(data);
    ctx.waitUntil(Promise.all([
      cache.put(fresh, new Response(body, { headers: { 'cache-control': `max-age=${ttl}` } })),
      cache.put(stale, new Response(body, { headers: { 'cache-control': `max-age=${STALE_TTL}` } }))
    ]));
    return data;
  } catch (err) {
    console.error('D1 read failed for', key, err);
    const old = await cache.match(stale);
    return old ? { ...(await old.json()), paused: true } : null;
  }
}

function purge(ctx, origin, ...keys) {
  ctx.waitUntil(Promise.all(keys.map((k) => caches.default.delete(new Request(`${origin}/__cache/fresh/${k}`)))));
}

async function getCount(env, ctx, origin) {
  const data = await cached(ctx, origin, 'count', COUNT_TTL, async () => ({
    count: await env.DB.prepare("SELECT value FROM counters WHERE name = 'signatures'").first('value')
  }));
  return data || { count: null, paused: true };
}

async function wallPage(env, cursor) {
  const rows = cursor
    ? await env.DB.prepare("SELECT id, display_name, city FROM signatures WHERE status = 'approved' AND id < ? ORDER BY id DESC LIMIT ?")
      .bind(cursor, WALL_PAGE + 1).all()
    : await env.DB.prepare("SELECT id, display_name, city FROM signatures WHERE status = 'approved' ORDER BY id DESC LIMIT ?")
      .bind(WALL_PAGE + 1).all();
  const items = rows.results.slice(0, WALL_PAGE);
  return {
    items: items.map((r) => ({ name: r.display_name, city: r.city || '' })),
    nextCursor: rows.results.length > WALL_PAGE ? String(items[items.length - 1].id) : null
  };
}

// Who a personal link belongs to: null if the code is unknown, {} while the
// sender's name is unreviewed, { name } once it is approved.
async function getSender(env, ctx, origin, code) {
  const data = await cached(ctx, origin, 'ref-' + code, REF_TTL, async () => {
    const row = await env.DB.prepare('SELECT display_name, status FROM signatures WHERE ref_code = ?').bind(code).first();
    return { known: !!row, name: row && row.status === 'approved' ? row.display_name : null };
  });
  if (!data || !data.known) return null;
  return data.name ? { name: data.name } : {};
}

// ---------- abuse protection ----------

// Rate limits are keyed by a hash of the IP; raw IPs are never stored.
async function rateLimited(binding, request, scope) {
  if (!binding) return false;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const { success } = await binding.limit({ key: await sha256Hex(scope + ':' + ip) });
  return !success;
}

// Returns null when the token is good, or a Response to send back.
async function checkTurnstile(env, token, request) {
  if (!env.TURNSTILE_SECRET) {
    console.error('TURNSTILE_SECRET is not set');
    return json({ error: PAUSED }, 503);
  }
  if (typeof token === 'string' && token) {
    const form = new FormData();
    form.append('secret', env.TURNSTILE_SECRET);
    form.append('response', token);
    const ip = request.headers.get('cf-connecting-ip');
    if (ip) form.append('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const out = await res.json();
    if (out.success === true) return null;
  }
  return json({ error: 'Please complete the check and try again.' }, 400);
}

const TOO_MANY = () => json({ error: 'Too many attempts. Please wait a minute and try again.' }, 429);

// ---------- public API ----------

async function publicApi(request, env, ctx, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/count' && method === 'GET') {
    return json(await getCount(env, ctx, url.origin), 200, { 'cache-control': 'public, max-age=15' });
  }

  if (path === '/api/wall' && method === 'GET') {
    const cursor = url.searchParams.get('cursor');
    if (cursor && !/^\d+$/.test(cursor)) return json({ error: 'Bad cursor.' }, 400);
    if (cursor) {
      try { return json(await wallPage(env, Number(cursor))); } catch (err) {
        console.error(err);
        return json({ items: [], nextCursor: null, paused: true });
      }
    }
    const data = await cached(ctx, url.origin, 'wall', WALL_TTL, () => wallPage(env, null));
    return json(data || { items: [], nextCursor: null, paused: true }, 200, { 'cache-control': 'public, max-age=15' });
  }

  const ref = path.match(/^\/api\/ref\/([^/]+)$/);
  if (ref && method === 'GET') {
    const sender = REF_RE.test(ref[1]) ? await getSender(env, ctx, url.origin, ref[1]) : null;
    return json(sender || {}, 200, { 'cache-control': 'public, max-age=60' });
  }

  if (path === '/api/sign' && method === 'POST') return sign(request, env, ctx, url);
  if (path === '/api/remove-request' && method === 'POST') return removeRequest(request, env);
  return notFound();
}

async function sign(request, env, ctx, url) {
  if (await rateLimited(env.SIGN_LIMIT, request, 'sign')) return TOO_MANY();
  const body = await readJSON(request);
  const { value, error } = validateSignature(body);
  if (error) return json({ error }, 400);
  const bad = await checkTurnstile(env, body.turnstileToken, request);
  if (bad) return bad;

  const insert = env.DB.prepare(
    `INSERT INTO signatures
       (name, display_name, email, city, wants_updates, show_full_name, ref_code, referred_by, norm_estimate, followup_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT id FROM signatures WHERE ref_code = ?), ?, ?)`
  );
  const count = env.DB.prepare("SELECT value FROM counters WHERE name = 'signatures'");

  // A clash on the random codes is very unlikely; try again with new ones.
  for (let attempt = 0; attempt < 3; attempt++) {
    const refCode = newRefCode();
    try {
      const [, total] = await env.DB.batch([
        insert.bind(value.name, value.displayName, value.email, value.city, value.wantsUpdates ? 1 : 0,
          value.showFullName ? 1 : 0, refCode, value.ref, value.normEstimate, newToken()),
        count
      ]);
      return json({ count: total.results[0].value, refCode });
    } catch (err) {
      const message = String(err && err.message);
      if (message.includes('signatures.email')) return json({ error: "You've already signed. Thank you." }, 409);
      if (message.includes('signatures.ref_code') || message.includes('signatures.followup_token')) continue;
      console.error('Sign failed', err);
      return json({ error: PAUSED }, 503);
    }
  }
  return json({ error: 'Something went wrong. Please try again.' }, 500);
}

async function removeRequest(request, env) {
  if (await rateLimited(env.REMOVE_LIMIT, request, 'remove')) return TOO_MANY();
  const body = await readJSON(request);
  const email = normalizeEmail(body && body.email);
  if (!isEmail(email)) return json({ error: 'Please enter a valid email address.' }, 400);
  const bad = await checkTurnstile(env, body.turnstileToken, request);
  if (bad) return bad;
  try {
    await env.DB.prepare('INSERT INTO removal_requests (email) VALUES (?)').bind(email).run();
  } catch (err) {
    console.error('Removal request failed', err);
    return json({ error: 'Something went wrong. Please try again later.' }, 503);
  }
  // Same answer whether or not the email has signed.
  return json({ ok: true });
}

// ---------- home page ----------

// Renders the count (and the "sent you this" line for personal links) into the
// HTML, so the page needs no second request.
async function homePage(request, env, ctx, url) {
  const res = await env.ASSETS.fetch(request);
  if (!res.ok || !(res.headers.get('content-type') || '').includes('text/html')) return res;

  const count = await getCount(env, ctx, url.origin);
  const code = url.searchParams.get('from');
  const sender = code && REF_RE.test(code) ? await getSender(env, ctx, url.origin, code) : null;

  // data-rendered tells the page script the Worker has filled things in.
  let rewriter = new HTMLRewriter()
    .on('body', { element(el) { el.setAttribute('data-rendered', ''); } });
  if (count.count !== null && count.count !== undefined) {
    rewriter = rewriter.on('#count', {
      element(el) {
        el.setInnerContent(Number(count.count).toLocaleString('en-US'));
        el.setAttribute('data-count', String(count.count));
      }
    });
  }
  if (count.paused) {
    rewriter = rewriter
      .on('body', { element(el) { el.setAttribute('data-paused', 'true'); } })
      .on('#sign-error', { element(el) { el.setInnerContent(PAUSED); } });
  }
  if (sender) {
    rewriter = rewriter.on('#sent-by', {
      element(el) {
        el.removeAttribute('hidden');
        el.setInnerContent(sender.name
          ? `<strong>${escapeHTML(sender.name)}</strong> sent you this.`
          : 'A man you know sent you this.', { html: true });
      }
    });
  }

  const out = rewriter.transform(res);
  const headers = new Headers(out.headers);
  headers.delete('etag');
  headers.set('cache-control', 'no-cache');
  return new Response(out.body, { status: out.status, headers });
}

// ---------- follow-up ----------

// The email links open a page with a button rather than recording the answer on
// GET, because mail scanners follow links in emails automatically.
async function followup(request, env, url) {
  const token = url.searchParams.get('t') || '';
  const valid = TOKEN_RE.test(token);

  if (request.method === 'POST') {
    const form = await request.formData();
    const answer = form.get('a');
    const t = String(form.get('t') || '');
    if (!TOKEN_RE.test(t) || (answer !== 'yes' && answer !== 'no')) return followupPage('broken', '');
    let saved;
    try {
      saved = await env.DB.prepare(
        `INSERT INTO followups (signature_id, answer)
         SELECT id, ? FROM signatures WHERE followup_token = ?
         ON CONFLICT (signature_id) DO UPDATE SET answer = excluded.answer, created_at = datetime('now')`
      ).bind(answer, t).run();
    } catch (err) {
      console.error('Follow-up failed', err);
      return followupPage('error', '');
    }
    return followupPage(saved.meta.changes ? answer : 'broken', '');
  }

  return followupPage(valid ? 'ask' : 'broken', token);
}

function followupPage(state, token) {
  const content = {
    ask: `<h1 class="display">Did the pledge lead to a conversation with another man?</h1>
<p class="lede">One tap. Your answer is private and helps us see whether the pledge is working.</p>
<form method="post" class="followup-form">
<input type="hidden" name="t" value="${escapeHTML(token)}">
<button class="btn btn-primary btn-lg" name="a" value="yes">Yes, it did</button>
<button class="btn btn-lg" name="a" value="no">Not yet</button>
</form>`,
    yes: `<h1 class="display">Thank you.</h1>
<p class="lede">Conversations between men are how this changes.</p>`,
    no: `<h1 class="display">Thanks for telling us.</h1>
<p class="lede">If the moment comes, <a href="/intervene/">the 5 Ds of safe intervention</a> can help.</p>`,
    broken: `<h1 class="display">This link didn't work.</h1>
<p class="lede">It may be incomplete or out of date. Thank you for taking the pledge.</p>`,
    error: `<h1 class="display">Something went wrong.</h1>
<p class="lede">Please try the link again later.</p>`
  }[state];

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>One question · The Intervention Pledge</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&amp;family=Public+Sans:wght@400;500;600;700&amp;display=swap">
<link rel="stylesheet" href="/assets/site.css">
</head>
<body>
<header class="site-header">
<div class="container">
<a class="brand" href="/">The Intervention Pledge</a>
</div>
</header>
<main class="narrow">
${content}
</main>
</body>
</html>`;
  return new Response(html, {
    status: state === 'broken' ? 404 : state === 'error' ? 503 : 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
  });
}

// ---------- admin ----------

// Cloudflare Access if it is configured, otherwise HTTP basic auth with the
// ADMIN_PASSWORD secret. With neither, admin is closed.
async function requireAdmin(request, env) {
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    if (await accessOk(request, env)) return null;
    return new Response('Forbidden', { status: 403 });
  }
  if (env.ADMIN_PASSWORD) {
    const header = request.headers.get('authorization') || '';
    if (header.startsWith('Basic ')) {
      let decoded = '';
      try { decoded = atob(header.slice(6)); } catch { /* bad header */ }
      const password = decoded.slice(decoded.indexOf(':') + 1);
      if (safeEqual(password, env.ADMIN_PASSWORD)) return null;
    }
    return new Response('Sign in to review names.', {
      status: 401,
      headers: { 'www-authenticate': 'Basic realm="Pledge admin", charset="UTF-8"' }
    });
  }
  return new Response('Admin is not configured.', { status: 503 });
}

function base64url(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

// Verifies the JWT that Cloudflare Access adds to every request it lets through.
async function accessOk(request, env) {
  try {
    const jwt = request.headers.get('cf-access-jwt-assertion');
    if (!jwt) return false;
    const [h, p, s] = jwt.split('.');
    const header = JSON.parse(new TextDecoder().decode(base64url(h)));
    const payload = JSON.parse(new TextDecoder().decode(base64url(p)));
    const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (header.alg !== 'RS256' || payload.iss !== issuer || !audiences.includes(env.ACCESS_AUD)) return false;
    if (!payload.exp || payload.exp * 1000 < Date.now()) return false;
    const certs = await fetch(`${issuer}/cdn-cgi/access/certs`, { cf: { cacheTtl: 3600 } }).then((r) => r.json());
    const jwk = (certs.keys || []).find((k) => k.kid === header.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64url(s), new TextEncoder().encode(h + '.' + p));
  } catch (err) {
    console.error('Access check failed', err);
    return false;
  }
}

async function adminApi(request, env, ctx, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/admin/pending' && method === 'GET') {
    const rows = await env.DB.prepare(
      "SELECT id, name, display_name, city, email, created_at FROM signatures WHERE status = 'pending' ORDER BY id DESC LIMIT 200"
    ).all();
    return json({
      items: rows.results.map((r) => ({
        id: r.id, entered: r.name, shown: r.display_name, city: r.city || '',
        email: maskEmail(r.email), when: timeAgo(r.created_at), status: 'pending'
      }))
    });
  }

  const decision = path.match(/^\/api\/admin\/(approve|reject|undo)$/);
  if (decision && method === 'POST') {
    const body = await readJSON(request);
    const id = body && Number(body.id);
    if (!Number.isInteger(id)) return json({ error: 'Missing id.' }, 400);
    const status = { approve: 'approved', reject: 'rejected', undo: 'pending' }[decision[1]];
    const row = await env.DB.prepare('UPDATE signatures SET status = ? WHERE id = ? RETURNING ref_code')
      .bind(status, id).first();
    if (!row) return notFound();
    purge(ctx, url.origin, 'wall', 'ref-' + row.ref_code);
    return json({ ok: true, status });
  }

  if (path === '/api/admin/removals' && method === 'GET') {
    const open = await env.DB.prepare(
      `SELECT r.id, r.email, r.created_at, EXISTS (SELECT 1 FROM signatures s WHERE s.email = r.email) AS signed
       FROM removal_requests r WHERE r.handled_at IS NULL ORDER BY r.id`
    ).all();
    const kit = await env.DB.prepare(
      'SELECT id, email, handled_at FROM removal_requests WHERE needs_kit_removal = 1 AND kit_removed_at IS NULL ORDER BY id'
    ).all();
    return json({
      items: open.results.map((r) => ({ id: r.id, email: r.email, when: timeAgo(r.created_at), signed: !!r.signed })),
      kitRemovals: kit.results.map((r) => ({ id: r.id, email: r.email, when: timeAgo(r.handled_at) }))
    });
  }

  // { id, remove: true } deletes the signature after the admin has confirmed with
  // the signer; { id, remove: false } closes the request without deleting.
  if (path === '/api/admin/removals/resolve' && method === 'POST') {
    const body = await readJSON(request);
    const id = body && Number(body.id);
    if (!Number.isInteger(id)) return json({ error: 'Missing id.' }, 400);
    const req = await env.DB.prepare('SELECT email FROM removal_requests WHERE id = ? AND handled_at IS NULL').bind(id).first();
    if (!req) return notFound();
    let removed = null;
    if (body.remove === true) {
      removed = await env.DB.prepare('DELETE FROM signatures WHERE email = ? RETURNING ref_code, exported_at')
        .bind(req.email).first();
    }
    const needsKit = !!(removed && removed.exported_at);
    await env.DB.prepare("UPDATE removal_requests SET handled_at = datetime('now'), needs_kit_removal = ? WHERE id = ?")
      .bind(needsKit ? 1 : 0, id).run();
    if (removed) purge(ctx, url.origin, 'wall', 'count', 'ref-' + removed.ref_code);
    return json({ ok: true, removed: !!removed, needsKitRemoval: needsKit });
  }

  if (path === '/api/admin/removals/kit-done' && method === 'POST') {
    const body = await readJSON(request);
    const id = body && Number(body.id);
    if (!Number.isInteger(id)) return json({ error: 'Missing id.' }, 400);
    await env.DB.prepare("UPDATE removal_requests SET kit_removed_at = datetime('now') WHERE id = ?").bind(id).run();
    return json({ ok: true });
  }

  // POST: download opted-in signers not yet exported, and mark them exported.
  // GET ?all=1: download everyone who opted in, without marking anything.
  if (path === '/api/admin/export.csv' && (method === 'POST' || (method === 'GET' && url.searchParams.get('all') === '1'))) {
    const onlyNew = method === 'POST';
    const rows = await env.DB.prepare(
      `SELECT id, name, display_name, email, city, ref_code, followup_token, created_at FROM signatures
       WHERE wants_updates = 1 ${onlyNew ? 'AND exported_at IS NULL' : ''} ORDER BY id`
    ).all();
    const items = rows.results.map((r) => ({ ...r, first_name: r.name.split(' ')[0], signed_at: r.created_at }));
    if (onlyNew && items.length) {
      // Mark in chunks to stay under D1's bound-parameter limit.
      const stmts = [];
      for (let i = 0; i < items.length; i += 90) {
        const ids = items.slice(i, i + 90).map((r) => r.id);
        stmts.push(env.DB.prepare(`UPDATE signatures SET exported_at = datetime('now') WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids));
      }
      await env.DB.batch(stmts);
    }
    const csv = toCSV(['email', 'first_name', 'display_name', 'city', 'ref_code', 'followup_token', 'signed_at'], items);
    const day = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="pledge-subscribers-${onlyNew ? 'new' : 'all'}-${day}.csv"`,
        'cache-control': 'no-store'
      }
    });
  }

  if (path === '/api/admin/metrics' && method === 'GET') return json(await metrics(env));

  return notFound();
}

async function metrics(env) {
  const [total, forwarded, norms, answers] = await env.DB.batch([
    env.DB.prepare("SELECT value FROM counters WHERE name = 'signatures'"),
    env.DB.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT referred_by) AS senders FROM signatures WHERE referred_by IS NOT NULL'),
    env.DB.prepare(
      `SELECT date(created_at, '-6 days', 'weekday 1') AS week, referred_by IS NOT NULL AS forwarded,
              norm_estimate AS v, COUNT(*) AS c
       FROM signatures WHERE norm_estimate IS NOT NULL GROUP BY 1, 2, 3 ORDER BY 1`
    ),
    env.DB.prepare('SELECT answer, COUNT(*) AS c FROM followups GROUP BY answer')
  ]);

  const signatures = total.results[0].value;
  const { n: viaForward, senders } = forwarded.results[0];

  const weeks = {};
  for (const r of norms.results) {
    const w = (weeks[r.week] ||= { forwarded: {}, direct: {} });
    w[r.forwarded ? 'forwarded' : 'direct'][r.v] = r.c;
  }
  const normByWeek = Object.keys(weeks).sort().map((week) => ({
    week, forwarded: summarize(weeks[week].forwarded), direct: summarize(weeks[week].direct)
  }));

  const counts = Object.fromEntries(answers.results.map((r) => [r.answer, r.c]));
  const yes = counts.yes || 0;
  const no = counts.no || 0;

  return {
    signatures,
    viaForward,
    shareViaForward: signatures ? viaForward / signatures : null,
    forwarders: senders,
    newSignersPerForwarder: senders ? viaForward / senders : null,
    normByWeek,
    followups: { yes, no, conversationRate: yes + no ? yes / (yes + no) : null }
  };
}
