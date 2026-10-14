// Pure helpers shared by the Worker. No bindings here, so they can be unit tested
// with `node --test`.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// No 0/o, 1/l/i: the code is read off phones and sometimes typed.
const REF_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const REF_RE = /^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/;

const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

// Collapse whitespace and drop control characters.
export function clean(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFC').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Same rule as the front end: the full name if the signer opted in, otherwise
// first word + initial of last word + "."
export function displayName(name, full) {
  const parts = clean(name).split(' ').filter(Boolean);
  if (!parts.length) return '';
  if (full || parts.length === 1) return parts.join(' ');
  return parts[0] + ' ' + parts[parts.length - 1].charAt(0).toUpperCase() + '.';
}

export function normalizeEmail(value) {
  return clean(value).toLowerCase();
}

export function isEmail(value) {
  return value.length <= 254 && EMAIL_RE.test(value);
}

// Checks a POST /api/sign body. Returns { value } or { error }.
export function validateSignature(body) {
  if (!body || typeof body !== 'object') return { error: 'Please fill in the form.' };
  const name = clean(body.name);
  const email = normalizeEmail(body.email);
  const city = clean(body.city);
  if (!name) return { error: 'Please enter your name.' };
  if (name.length > 100) return { error: 'Please use a shorter name.' };
  if (!isEmail(email)) return { error: 'Please enter a valid email address.' };
  if (city.length > 80) return { error: 'Please use a shorter city name.' };

  let normEstimate = null;
  if (body.normEstimate !== undefined && body.normEstimate !== null && body.normEstimate !== '') {
    const n = Number(body.normEstimate);
    if (!Number.isInteger(n) || n < 0 || n > 10) return { error: 'Please pick a number from 0 to 10.' };
    normEstimate = n;
  }

  const ref = typeof body.ref === 'string' && REF_RE.test(body.ref) ? body.ref : null;
  const showFullName = body.showFullName === true;

  return {
    value: {
      name,
      displayName: displayName(name, showFullName),
      email,
      city: city || null,
      wantsUpdates: body.wantsUpdates === true,
      showFullName,
      normEstimate,
      ref
    }
  };
}

function randomString(length, alphabet) {
  // Rejection sampling keeps every character equally likely.
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of bytes) {
      if (b < limit && out.length < length) out += alphabet[b % alphabet.length];
    }
  }
  return out;
}

export function newRefCode() { return randomString(8, REF_ALPHABET); }
export function newToken() { return randomString(22, TOKEN_ALPHABET); }

// "marcus@gmail.com" -> "m•••@gmail.com", for the admin review table.
export function maskEmail(email) {
  const at = email.indexOf('@');
  if (at < 1) return '•••';
  return email.charAt(0) + '•••' + email.slice(at);
}

// D1 stores "YYYY-MM-DD HH:MM:SS" in UTC.
export function parseDbTime(text) {
  return Date.parse(text.replace(' ', 'T') + 'Z');
}

export function timeAgo(text, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - parseDbTime(text)) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + ' min ago';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + ' hr ago';
  const days = Math.round(hours / 24);
  return days === 1 ? '1 day ago' : days + ' days ago';
}

// RFC 4180 CSV. Cells that a spreadsheet would run as a formula get a leading quote.
export function toCSV(columns, rows) {
  const cell = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => cell(row[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Compares two strings without leaking where they differ.
export function safeEqual(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

// Mean and median from { value: count } pairs.
export function summarize(counts) {
  const values = Object.keys(counts).map(Number).sort((a, b) => a - b);
  const n = values.reduce((sum, v) => sum + counts[v], 0);
  if (!n) return { n: 0, mean: null, median: null };
  const mean = values.reduce((sum, v) => sum + v * counts[v], 0) / n;
  const at = (k) => { let seen = 0; for (const v of values) { seen += counts[v]; if (seen > k) return v; } };
  const median = n % 2 ? at((n - 1) / 2) : (at(n / 2 - 1) + at(n / 2)) / 2;
  return { n, mean: Math.round(mean * 10) / 10, median };
}

export function escapeHTML(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
