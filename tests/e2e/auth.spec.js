// The sign-in page must always show the social sign-in buttons (regression
// for the rate-limited public-config bug) and stay visually neutral.
const { test, expect } = require('@playwright/test');

test('public-config returns the enabled providers (not rate-limited)', async ({ request }) => {
  // Hammer it: safe reads must be exempt from the auth rate limiter.
  for (let i = 0; i < 6; i++) {
    const res = await request.get('/api/auth/public-config');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.providers).toContain('google');
    expect(body.providers).toContain('github');
  }
});

test('sign-in page shows Google and GitHub buttons', async ({ page }) => {
  await page.goto('/auth.html');
  await expect(page.locator('#oauthGoogleBtn')).toBeVisible();
  await expect(page.locator('#oauthGithubBtn')).toBeVisible();
  await expect(page.locator('#oauthSection')).toBeVisible();
});

test('sign-in page is neutral (brand not blue)', async ({ page }) => {
  await page.goto('/auth.html');
  // neutral accent-light === #94a3b8
  await expect(page.locator('.auth-header h1')).toHaveCSS('color', 'rgb(148, 163, 184)');
});
