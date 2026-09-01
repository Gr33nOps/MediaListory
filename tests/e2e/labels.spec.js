// The TV category is labelled "Shows" everywhere in the UI (internally still
// media_type 'series' / series.html — those must not leak into the UI text).
const { test, expect } = require('@playwright/test');

test('nav shows "Shows", never "Series"', async ({ page }) => {
  await page.goto('/movies.html');
  const nav = page.locator('.nav-actions');
  await expect(nav.getByRole('link', { name: 'Shows' })).toBeVisible();
  await expect(nav.getByText('Series', { exact: true })).toHaveCount(0);
});

test('the TV page identifies itself as Shows', async ({ page }) => {
  await page.goto('/series.html');
  await expect(page).toHaveTitle('Shows - MediaListory');
  await expect(page.locator('.page-header-title')).toHaveText('Shows');
});

test('nav category dots are all present', async ({ page }) => {
  await page.goto('/movies.html');
  for (const cat of ['movies', 'series', 'anime', 'games']) {
    await expect(page.locator(`.nav-actions .btn[data-cat="${cat}"]`)).toBeVisible();
  }
});
