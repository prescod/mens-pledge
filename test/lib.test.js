import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  displayName, validateSignature, newRefCode, newToken, REF_RE, TOKEN_RE,
  maskEmail, timeAgo, toCSV, safeEqual, summarize, escapeHTML
} from '../src/lib.js';

test('displayName: first name and last initial, or the full name when opted in', () => {
  assert.equal(displayName('  Daniel   Okafor ', false), 'Daniel O.');
  assert.equal(displayName('Jean Luc picard', false), 'Jean P.');
  assert.equal(displayName('Raj', false), 'Raj');
  assert.equal(displayName('  Daniel   Okafor ', true), 'Daniel Okafor');
  assert.equal(displayName('', true), '');
});

test('validateSignature accepts a good body and normalizes it', () => {
  const { value, error } = validateSignature({
    name: ' Marcus  Robinson ', email: ' Marcus@Gmail.COM ', city: ' Vancouver ',
    wantsUpdates: true, showFullName: false, normEstimate: 7, ref: 'abcd2345'
  });
  assert.equal(error, undefined);
  assert.deepEqual(value, {
    name: 'Marcus Robinson', displayName: 'Marcus R.', email: 'marcus@gmail.com', city: 'Vancouver',
    wantsUpdates: true, showFullName: false, normEstimate: 7, ref: 'abcd2345'
  });
});

test('validateSignature: optional fields and loose types', () => {
  const { value } = validateSignature({ name: 'Tom Walsh', email: 't@x.ca', wantsUpdates: 'yes', normEstimate: '', ref: 'NOT-A-CODE' });
  assert.equal(value.city, null);
  assert.equal(value.wantsUpdates, false, 'only a real true opts in');
  assert.equal(value.normEstimate, null);
  assert.equal(value.ref, null);
});

test('validateSignature rejects bad input', () => {
  assert.ok(validateSignature(null).error);
  assert.ok(validateSignature({ name: '   ', email: 'a@b.co' }).error);
  assert.ok(validateSignature({ name: 'x'.repeat(101), email: 'a@b.co' }).error);
  assert.ok(validateSignature({ name: 'Tom', email: 'not-an-email' }).error);
  assert.ok(validateSignature({ name: 'Tom', email: 'a@b.co', city: 'c'.repeat(81) }).error);
  assert.ok(validateSignature({ name: 'Tom', email: 'a@b.co', normEstimate: 11 }).error);
  assert.ok(validateSignature({ name: 'Tom', email: 'a@b.co', normEstimate: 2.5 }).error);
});

test('random codes have the right shape', () => {
  for (let i = 0; i < 200; i++) {
    assert.match(newRefCode(), REF_RE);
    assert.match(newToken(), TOKEN_RE);
  }
});

test('maskEmail', () => {
  assert.equal(maskEmail('marcus@gmail.com'), 'm•••@gmail.com');
  assert.equal(maskEmail('broken'), '•••');
});

test('timeAgo reads D1 timestamps as UTC', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  assert.equal(timeAgo('2026-10-14 11:59:50', now), 'just now');
  assert.equal(timeAgo('2026-10-14 11:56:00', now), '4 min ago');
  assert.equal(timeAgo('2026-10-14 10:00:00', now), '2 hr ago');
  assert.equal(timeAgo('2026-10-13 12:00:00', now), '1 day ago');
});

test('toCSV quotes and defuses formulas', () => {
  const csv = toCSV(['a', 'b'], [{ a: 'x,y', b: '=SUM(A1)' }, { a: 'say "hi"', b: null }]);
  assert.equal(csv, 'a,b\r\n"x,y",\'=SUM(A1)\r\n"say ""hi""",\r\n');
});

test('safeEqual', () => {
  assert.equal(safeEqual('secret', 'secret'), true);
  assert.equal(safeEqual('secret', 'secreT'), false);
  assert.equal(safeEqual('secret', 'secret!'), false);
});

test('summarize gives mean and median from counts', () => {
  assert.deepEqual(summarize({}), { n: 0, mean: null, median: null });
  assert.deepEqual(summarize({ 3: 1, 5: 2, 9: 1 }), { n: 4, mean: 5.5, median: 5 });
  assert.deepEqual(summarize({ 2: 1, 8: 1 }), { n: 2, mean: 5, median: 5 });
});

test('escapeHTML', () => {
  assert.equal(escapeHTML('<b>"Tom" & \'Jerry\'</b>'), '&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;');
});
