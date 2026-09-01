// Guests can browse every category, results render, and search works.
const { test, expect } = require('@playwright/test');

const PAGES = [
  { path: '/movies.html', search: 'Search for movies...' },
  { path: '/series.html', search: 'Search for shows...' },
  { path: '/anime.html',  search: 'Search for anime...' },
  { path: '/home.html',   search: 'Search for games...' },
];

for (const p of PAGES) {
  test(`guest can browse ${p.path}`, async ({ page }) => {
    await page.goto(p.path);
    // results render for guests (no login required)
    await expect(page.locator('.game-card').first()).toBeVisible({ timeout: 20000 });
    expect(await page.locator('.game-card').count()).toBeGreaterThan(0);
    // search box has the category-specific placeholder
    await expect(page.locator('.search-input').first()).toHaveAttribute('placeholder', p.search);
  });
}

test('anime detail resolves for a guest', async ({ page }) => {
  await page.goto('/anime.html');
  await page.locator('.game-card').first().waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('.game-card').first().click();
  // a detail modal / view with the title opens
  await expect(page.locator('.game-detail-hero-img, #gameDetails, .modal-content').first())
    .toBeVisible({ timeout: 10000 });
});

test('SEO essentials are served', async ({ request }) => {
  for (const path of ['/robots.txt', '/sitemap.xml', '/favicon.svg', '/img/og-card.jpg']) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
  }
});
