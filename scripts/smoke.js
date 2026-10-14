// End-to-end check against a running Worker:
//   npx wrangler dev          (in another terminal, with .dev.vars from .dev.vars.example)
//   npm run smoke
// Uses Turnstile's test secret, which accepts any token. The sign limit is 5 a
// minute per IP, so wait a minute between runs.

import { readFileSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8787';
const password = process.env.ADMIN_PASSWORD ||
  (readFileSync('.dev.vars', 'utf8').match(/^ADMIN_PASSWORD=(.*)$/m) || [])[1];
const admin = { authorization: 'Basic ' + Buffer.from('admin:' + password).toString('base64') };
const run = Date.now().toString(36);
const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? 'ok   ' : 'FAIL ') + label + (ok || detail === undefined ? '' : '  ' + JSON.stringify(detail)));
  if (!ok) failures++;
}

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    redirect: 'manual',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  return { status: res.status, type, data };
}

const sign = (fields) => call('/api/sign', { method: 'POST', body: { turnstileToken: TOKEN, wantsUpdates: true, ...fields } });

const before = (await call('/api/count')).data.count;
check('count is a number', Number.isInteger(before), before);

const home = await call('/');
check('home page has the count rendered in', home.data.includes(`data-count="${before}"`) && home.data.includes('data-rendered'));

const sender = await sign({ name: `Sender ${run} Smith`, email: `sender-${run}@example.com`, normEstimate: 4 });
check('sign returns the new count and a ref code', sender.status === 200 && sender.data.count === before + 1 && /^[a-z2-9]{8}$/.test(sender.data.refCode), sender);
const code = sender.data.refCode;

check('a second signature with the same email is refused kindly',
  (await sign({ name: 'Someone Else', email: `SENDER-${run}@example.com ` })).status === 409);
check('signing without a Turnstile token is refused',
  (await call('/api/sign', { method: 'POST', body: { name: 'No Token', email: `nt-${run}@example.com` } })).status === 400);

check('personal link before review shows the generic line',
  (await call('/?from=' + code)).data.includes('A man you know sent you this.'));

check('admin needs a password', (await call('/api/admin/pending')).status === 401);
check('the admin page needs a password too', (await call('/admin/')).status === 401);
const pending = await call('/api/admin/pending', { headers: admin });
const row = pending.data.items && pending.data.items.find((r) => r.entered === `Sender ${run} Smith`);
check('the new signer is waiting for review, email masked', !!row && row.shown === `Sender S.` && row.email.startsWith('s•••@'), row);

check('approve', (await call('/api/admin/approve', { method: 'POST', headers: admin, body: { id: row.id } })).status === 200);
check('personal link after approval shows his name',
  (await call('/?from=' + code)).data.includes(`<strong>Sender S.</strong> sent you this.`));
check('ref lookup', (await call('/api/ref/' + code)).data.name === 'Sender S.');
check('the wall shows him', (await call('/api/wall')).data.items.some((i) => i.name === 'Sender S.'));

const friend = await sign({ name: `Friend ${run}`, email: `friend-${run}@example.com`, ref: code, normEstimate: 8, showFullName: true });
check('a forwarded signer is recorded', friend.status === 200, friend);

const metrics = (await call('/api/admin/metrics', { headers: admin })).data;
check('metrics count the forward', metrics.viaForward >= 1 && metrics.forwarders >= 1 && metrics.normByWeek.length >= 1, metrics);

const csv = await call('/api/admin/export.csv?all=1', { headers: admin });
check('CSV export', csv.type.startsWith('text/csv') && csv.data.startsWith('email,first_name,display_name,city,ref_code,followup_token,signed_at'));
const line = csv.data.split('\r\n').find((l) => l.startsWith(`friend-${run}@example.com`));
const token = line && line.split(',')[5];
check('the forwarded signer is in the export with a follow-up token', !!token && token.length === 22, line);

const ask = await call('/followup?t=' + token);
check('follow-up link shows the question, not a recorded answer', ask.status === 200 && ask.data.includes('Yes, it did'));
const answered = await fetch(BASE + '/followup?t=' + token, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `t=${token}&a=yes`
});
check('follow-up answer is recorded', answered.status === 200 && (await answered.text()).includes('Thank you.'));
check('a made-up follow-up token is rejected', (await call('/followup?t=nope')).status === 404);
const after = (await call('/api/admin/metrics', { headers: admin })).data;
check('metrics count the follow-up', after.followups.yes >= 1, after.followups);

check('removal request', (await call('/api/remove-request', { method: 'POST', body: { email: `friend-${run}@example.com`, turnstileToken: TOKEN } })).data.ok === true);
check('removal request for an unknown email gets the same answer',
  (await call('/api/remove-request', { method: 'POST', body: { email: `nobody-${run}@example.com`, turnstileToken: TOKEN } })).data.ok === true);
const removals = (await call('/api/admin/removals', { headers: admin })).data;
const request = removals.items.find((r) => r.email === `friend-${run}@example.com`);
check('admin sees the removal request and that he signed', !!request && request.signed === true, removals);
const resolved = await call('/api/admin/removals/resolve', { method: 'POST', headers: admin, body: { id: request.id, remove: true } });
check('resolving it deletes the signature', resolved.data.removed === true, resolved.data);

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
