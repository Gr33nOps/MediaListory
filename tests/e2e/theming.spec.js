// Per-category theming: each of the four category pages recolors the whole
// page (brand text + page accent), and the page-identity header is correct.
const { test, expect } = require('@playwright/test');

// nav-brand color === --accent-light for the page's category (solid color).
const CATEGORY = [
  { path: '/movies.html', page: 'movies', title: 'Movies', brand: 'rgb(96, 165, 250)' },
  { path: '/series.html', page: 'series', title: 'Shows',  brand: 'rgb(52, 211, 153)' },
  { path: '/anime.html',  page: 'anime',  title: 'Anime',  brand: 'rgb(244, 114, 182)' },
  { path: '/home.html',   page: 'games',  title: 'Games',  brand: 'rgb(251, 191, 36)' },
];

for (const c of CATEGORY) {
  test(`${c.title} page is themed (${c.page})`, async ({ page }) => {
    await page.goto(c.path);
    // body carries the category so CSS accents recolor
    await expect(page.locator('body')).toHaveAttribute('data-page', c.page);
    // single, correct page-identity header
    const h1 = page.locator('.page-header-title');
    await expect(h1).toHaveText(c.title);
    await expect(page.locator('h1')).toHaveCount(1);
    // brand text recolors to the category color
    const brand = page.locator('.nav-brand');
    await expect(brand).toHaveCSS('color', c.brand);
    // the four category tabs each carry a data-cat
    await expect(page.locator('.nav-actions .btn[data-cat]')).toHaveCount(4);
  });
}

test('non-category pages stay neutral (no category color)', async ({ page }) => {
  await page.goto('/about.html');
  // neutral accent-light === #94a3b8
  await expect(page.locator('.nav-brand')).toHaveCSS('color', 'rgb(148, 163, 184)');
});

test('two different category pages render different brand colors', async ({ page }) => {
  await page.goto('/movies.html');
  const movies = await page.locator('.nav-brand').evaluate((el) => getComputedStyle(el).color);
  await page.goto('/home.html');
  const games = await page.locator('.nav-brand').evaluate((el) => getComputedStyle(el).color);
  expect(movies).not.toBe(games);
});

test('page header is centered', async ({ page }) => {
  await page.goto('/anime.html');
  await expect(page.locator('.page-header')).toHaveCSS('text-align', 'center');
});
