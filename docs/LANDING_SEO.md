# Landing page hosting + SEO injection

## How it works (current setup)

```text
Browser / crawler → dater.social (Hostinger Apache)
                      │
                      ├─ /assets/*, images, fonts  → served as static files
                      │
                      └─ /, /about, /faq, …        → .htaccess → index.php
                                                      │
                                                      ├─ bot UA  → api.dater.social (Express injects SEO)
                                                      └─ browser   → index-spa.html (Vite SPA)
```

- **Hostinger** hosts the real site (JS/CSS/images).
- **Express** only needs a copy of the Vite SPA shell so it can inject `<title>`, `og:*`, etc. from Postgres.
- Do **not** copy the full `dist/` (images/assets) into the backend.

[`DaterLanding/public/index.php`](../../DaterLanding/public/index.php) proxies crawler requests to the API.
[`DaterLanding/public/.htaccess`](../../DaterLanding/public/.htaccess) routes document paths through PHP.

## Sync HTML into the backend (SPA shell only)

```bash
cd DaterLanding
npm run build:deploy
# then redeploy the backend
```

That runs [`scripts/sync-seo-html.sh`](../../DaterLanding/scripts/sync-seo-html.sh), which copies `dist/index-spa.html` to:

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

## Canonical URLs

In SEO admin, set canonicals to the public site URLs, e.g.:

- `https://dater.social/`
- `https://dater.social/about`

## Smoke checks

```bash
# Direct API injection
curl -s -A "facebookexternalhit/1.1" https://api.dater.social/ | head -n 40

# Via Hostinger (after deploy)
curl -s -A "facebookexternalhit/1.1" https://dater.social/ | head -n 40
curl -s -A "facebookexternalhit/1.1" https://dater.social/about | head -n 40
```

You should see injected meta tags in the raw HTML.
