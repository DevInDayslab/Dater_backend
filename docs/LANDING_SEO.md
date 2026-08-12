# Landing page hosting + SEO injection

The Express API can serve the Vite marketing site (`DaterLanding`) with **dynamic SEO tags** injected into `index.html` from PostgreSQL (`landing_page_seo`).

## Build & copy landing assets

```bash
# From DaterLanding
npm run build

# Copy dist into the backend (default path)
rm -rf ../backend/public/landing
mkdir -p ../backend/public/landing
cp -R dist/. ../backend/public/landing/
```

Override the path with env:

```bash
export LANDING_DIST_PATH=/absolute/path/to/DaterLanding/dist
```

`express.static` serves hashed assets from that folder. Document routes (`GET /`, `/about`, etc.) return SEO-injected `index.html` via `serveLandingWithDynamicSeo`.

## Migrate SEO table

```bash
cd backend
npm run migrate
```

Applies `sql/047_landing_page_seo.sql` (creates `landing_page_seo` + seeds `page_slug = 'home'`).

Offline module check (no DB):

```bash
DATABASE_URL=postgres://localhost:5432/dater npm run smoke:seo
```

## Admin API

Protected by existing admin auth (`requireAdminAuth`):

- `GET /api/v1/admin/seo`
- `PUT /api/v1/admin/seo` — body: `meta_title`, `meta_description`, `og_image_url`, `canonical_url`, `is_indexed`

Edit via the sibling app **`DaterSeoAdmin`** (port 5175 in dev).

## Production hosting (move off Vercel)

Point **`dater.social`** (or your marketing hostname) at the **same Node process** that runs this API (or a reverse proxy in front of it).

- Humans and crawlers (`facebookexternalhit`, Twitterbot, Googlebot) receive HTML with `<title>`, `og:*`, `twitter:*`, `robots`, and `canonical` already in the response — no client JS required.
- Retire Vercel as the origin for the marketing site once DNS/proxy cuts over.
- Keep `api.dater.social` as today if you prefer a split hostname; then either:
  - proxy `/` document traffic to this app, or
  - serve both API + landing from one host and use relative `/api/...` from the SPA.

## Local smoke checks

```bash
curl -s http://127.0.0.1:3000/health
curl -s -A "facebookexternalhit/1.1" http://127.0.0.1:3000/ | head -n 40
```

You should see injected meta tags in the raw HTML.
