# The Intervention Pledge

A pledge site for men: sign, see the live count, see who else has signed.

## Layout

- `public/`: the static site (plain HTML, one stylesheet, one script). This is
  the folder Workers Static Assets will serve once the back end exists.
  - `index.html` (pledge), `intervene/`, `thanks/`, `privacy/`, `admin/`
  - `assets/site.css`, `assets/site.js`
  - `images/`: black-and-white **placeholder** portraits. Replace the files and
    update the `alt` text and captions in `index.html`.

## Back end status

Not built yet. `assets/site.js` calls the planned API (`/api/count`,
`/api/wall`, `/api/sign`, `/api/remove-request`, `/api/admin/*`). When those
calls fail, the pages fall back to demo data so they can still be clicked
through. Nothing is saved in demo mode.

## Local preview

```sh
python3 -m http.server -d public 8000
# open http://localhost:8000/
```

## Deploying the preview

Every push to `main` deploys `public/` to GitHub Pages
(`.github/workflows/pages.yml`).
