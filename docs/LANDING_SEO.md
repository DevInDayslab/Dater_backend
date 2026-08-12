# Landing page hosting + SEO injection

## How it works (current setup)

```text
Browser / crawler → dater-landing.vercel.app (Vercel)
                      │
                      ├─ /assets/*, images, fonts  → served by Vercel
                      │
                      └─ /, /about, /faq, … (HTML) → middleware → api.dater.social
                                                      Express injects SEO into index.html
```

- **Vercel** hosts the real site (JS/CSS/images).
- **Express** only needs a copy of Vite’s **`index.html`** so it can inject `<title>`, `og:*`, etc. from Postgres.
- Do **not** copy the full `dist/` (images/assets) into the backend.

[`DaterLanding/middleware.js`](../../DaterLanding/middleware.js) proxies document routes to the API.

## Sync HTML into the backend (index.html only)

```bash
cd DaterLanding
npm run build
npm run sync:seo-html
# then redeploy the backend
```

That runs [`scripts/sync-seo-html.sh`](../../DaterLanding/scripts/sync-seo-html.sh), which places only:

`backend/public/landing/index.html`

Override folder with env (optional):

```bash
export LANDING_DIST_PATH=/absolute/path/to/folder/containing/index.html
```

## Migrate SEO table

```bash
cd backend
npm run migrate
```

Applies `sql/047_landing_page_seo.sql` (table + home seed) and
`sql/048_landing_page_seo_all_pages.sql` (all landing routes).

Offline module check (no DB):

```bash
DATABASE_URL=postgres://localhost:5432/dater npm run smoke:seo
```

## Admin API

Protected by existing admin auth (`requireAdminAuth`):

- `GET /api/v1/admin/seo` — list catalog + all rows
- `GET /api/v1/admin/seo/:slug` — one page (`home`, `about`, `faq`, …)
- `PUT /api/v1/admin/seo/:slug` — body: `meta_title`, `meta_description`, `og_image_url`, `canonical_url`, `is_indexed`
- `POST /api/v1/admin/seo/:slug/og-image/presign` — `{ contentType }` → S3 PUT URL for OG image
- `PUT /api/v1/admin/seo` — backward-compatible update for `home`

Document requests map path → slug. Response header `X-Landing-Seo-Slug` shows which slug was used.

**OG images:** uploaded to private S3 under `landing/seo/…`, then exposed to crawlers via:

`GET /api/v1/landing/seo-media/landing/seo/{page}/{id}.webp`

Injection rewrites old raw S3 `og:image` URLs to this public proxy automatically.

Edit via **`DaterSeoAdmin`**.

## Canonical URLs while testing on Vercel

In SEO admin, set canonicals to the public Vercel host, e.g.:

- `https://dater-landing.vercel.app/`
- `https://dater-landing.vercel.app/about`

When you attach `dater.social`, update those canonicals to the official URLs.

## Smoke checks

```bash
# Direct API injection
curl -s -A "facebookexternalhit/1.1" https://api.dater.social/ | head -n 40

# Via Vercel (after middleware deploy)
curl -s -A "facebookexternalhit/1.1" https://dater-landing.vercel.app/ | head -n 40
curl -s -A "facebookexternalhit/1.1" -D - https://dater-landing.vercel.app/about -o /dev/null | rg -i 'x-landing-seo-slug'
```

You should see injected meta tags in the raw HTML.
