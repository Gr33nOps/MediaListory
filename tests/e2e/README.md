# End-to-end tests (Playwright)

Browser regression tests for the flows we care about: per-category theming,
the "Shows" label, the sign-in OAuth buttons, guest browsing, and the SEO
assets. They run against the **deployed** site by default.

`@playwright/test` is intentionally **not** in the app's `package.json` — the
app deploys on Render with `npm install`, and we don't want Playwright's
browser download running on every deploy. Install it on demand instead.

## Run locally

```bash
npm install --no-save @playwright/test   # test runner
npx playwright install --with-deps chromium
npm run test:e2e                          # against production
```

Target a different environment with `BASE_URL`:

```bash
BASE_URL=http://localhost:3000 npm run test:e2e
```

## What's covered
- `theming.spec.js` — each category page recolors the whole page (brand +
  accent), the page header is centered, and there's exactly one H1.
- `labels.spec.js` — the TV category reads "Shows" (never "Series") in the UI.
- `auth.spec.js` — `public-config` isn't rate-limited and the Google/GitHub
  buttons are visible (regression for the disappearing-OAuth-buttons bug).
- `browse.spec.js` — guests can browse all four categories, open a detail, and
  the SEO files (robots, sitemap, favicon, social card) are served.

CI runs these on a schedule and on demand via
`.github/workflows/e2e.yml`.
