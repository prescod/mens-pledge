# The Intervention Pledge

A pledge site for men: sign, see the live count, see who else has signed, and
send it to the men you know.

## Layout

- `public/`: the static site (plain HTML, one stylesheet, one script), served by
  Workers Static Assets.
  - `index.html` (pledge), `intervene/`, `thanks/`, `privacy/`, `admin/`
  - `assets/site.css`, `assets/site.js`
  - `images/`: black-and-white **placeholder** portraits, plus `share.png`
    (the link-preview image; regenerate with `tools/share-image.py`).
- `src/index.js`: the Worker. Serves `public/` and the JSON API.
- `src/lib.js`: validation and other pure helpers (unit tested).
- `migrations/`: the D1 schema (`wrangler d1 migrations`).
- `test/`: unit tests. `scripts/smoke.js`: end-to-end checks against a running Worker.

## API

| Route | What it does |
|---|---|
| `GET /api/count` | Total signatures (cached ~45 s) |
| `GET /api/wall?cursor=` | Approved names, newest first, 48 a page (first page cached) |
| `GET /api/ref/:code` | Name behind a personal link, once approved |
| `POST /api/sign` | `{ name, email, city?, wantsUpdates, showFullName, normEstimate?, ref?, turnstileToken }` → `{ count, refCode }` |
| `POST /api/remove-request` | `{ email, turnstileToken }`; same answer whether or not the email signed |
| `GET/POST /followup?t=` | One-question follow-up linked from Kit emails |
| `/api/admin/*` | `pending`, `approve`, `reject`, `undo`, `removals`, `removals/resolve`, `removals/kit-done`, `export.csv`, `metrics` |

The home page (`/`) also runs through the Worker, which renders the count and
the "Marcus R. sent you this" line into the HTML.

**When D1 is over its free-tier limit**, the count and wall fall back to a
week-old cached copy, the page says "Signing is paused, please try again
later", and signing returns 503 instead of erroring.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars        # test Turnstile secret + an admin password
npm run db:migrate:local              # creates the local D1 in .wrangler/
npm run dev                           # http://localhost:8787
```

Admin is at http://localhost:8787/admin/ (any user name, the `ADMIN_PASSWORD`
from `.dev.vars`).

Tests:

```sh
npm test                              # unit tests
npm run smoke                         # end-to-end, with `npm run dev` running
```

The smoke test signs up throwaway `@example.com` addresses in the local
database. The sign limit is 5 a minute per IP, so wait a minute between runs.

## Deploying

One-time setup:

```sh
npx wrangler login
npx wrangler d1 create pledge         # put the printed database_id in wrangler.toml
npm run db:migrate:remote
npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put ADMIN_PASSWORD   # unless Cloudflare Access protects /admin
```

- **Turnstile:** create a widget in the Cloudflare dashboard, then replace the
  test site key `1x00000000000000000000AA` in `public/index.html` and
  `public/privacy/index.html`.
- **Cloudflare Access (preferred for admin):** protect `/admin*` and
  `/api/admin/*` with an Access application, then set the `ACCESS_TEAM_DOMAIN`
  and `ACCESS_AUD` variables. When they are set, the Worker checks the Access
  token and ignores `ADMIN_PASSWORD`.
- **Custom domain:** the Cache API does not work on `*.workers.dev`, so serve
  the Worker from your own domain before launch. Then update the absolute URLs in
  the link-preview tags (`og:url`, `og:image`) on each page.

Then, and for every later change:

```sh
npm run deploy
```

## Mailing list (Kit)

`wants_updates` in D1 is the source of truth for consent. On `/admin`,
**Download new subscribers** gives a CSV of opted-in signers not exported
before, and marks them exported. Import it into Kit with `ref_code` and
`followup_token` as custom fields; the follow-up email links to
`https://YOUR-DOMAIN/followup?t={{ subscriber.followup_token }}`.

When a removal request deletes someone who was already exported, the admin API
lists them under `kitRemovals` so they can be removed from Kit by hand.

## Static preview

Every push to `main` also deploys `public/` to GitHub Pages
(`.github/workflows/pages.yml`). There is no API there, so the pages fall back
to demo data.
