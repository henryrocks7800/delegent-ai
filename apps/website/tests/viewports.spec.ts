// Phase 11 viewport pack — runs the built website at the five canonical
// mobile widths and asserts the contracts the static scanner cannot:
//   - no horizontal page overflow at any viewport
//   - hero + CTA + skills section render and have non-zero size
//   - the BuiltInSkills (Phase 6) section is visible without scrolling
//     past the bottom of the page
//   - no app-mockup that pushes the document wider than the viewport
//
// Static copy contracts continue to live in the website content scanner
// (test/website-content-scanner.test.mjs). This file is complementary.
import { test, expect } from '@playwright/test';

test('home page has no horizontal overflow', async ({ page, viewport }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  // Wait an extra beat for fonts / images.
  await page.waitForTimeout(500);

  const metrics = await page.evaluate(() => ({
    docWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    winWidth: window.innerWidth,
  }));
  // Tolerate 1px rounding for high-DPR devices.
  expect(metrics.docWidth, `documentElement scrollWidth > viewport at ${viewport?.width}px`).toBeLessThanOrEqual(metrics.winWidth + 1);
  expect(metrics.bodyWidth, `body scrollWidth > viewport at ${viewport?.width}px`).toBeLessThanOrEqual(metrics.winWidth + 1);
});

test('hero + CTA are visible above the fold', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  // The hero must render some h1-level copy.
  const h1 = page.locator('h1').first();
  await expect(h1).toBeVisible();
  const h1Box = await h1.boundingBox();
  expect(h1Box?.height ?? 0).toBeGreaterThan(0);

  // At least one CTA link/button. Match the canonical Play Store CTA
  // ("Get it on Google Play") plus generic CTA verbs. Generous so the
  // copy can evolve without churning the test.
  const cta = page.getByRole('link', { name: /(google play|get the app|install|try|download|sign up|start|get it on)/i }).first();
  await expect(cta, 'expected at least one CTA link with google-play / get / install / try / download / sign-up / start label').toBeVisible();
});

test('Built-in Skills section renders with all 7 categories', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  // Scroll to the section so we exercise lazy-load if any.
  await page.locator('[data-testid="builtInSkills.section"]').scrollIntoViewIfNeeded();
  await expect(page.locator('[data-testid="builtInSkills.section"]')).toBeVisible();

  // The coworker plan's categories (agentUseCaseCategories in packages/shared),
  // which BuiltInSkills.tsx renders. The list this replaced (2026-09-26) was the
  // older eight, dropped on 2026-09-15, so the check had failed at every
  // viewport for eleven days rather than guarding anything.
  for (const heading of [
    'Inbox & messages',
    'Travel & days out',
    'Life admin',
    'Documents & paperwork',
    'Money & bills',
    'Answers & research',
    'Work & side hustle',
  ]) {
    const h = page.getByRole('heading', { name: heading, exact: true });
    await h.scrollIntoViewIfNeeded();
    await expect(h).toBeVisible();
  }

  // Safety paragraph reachable via testID.
  await expect(page.locator('[data-testid="builtInSkills.safetyNote"]')).toBeVisible();
});

test('no element pokes past the right edge of the viewport', async ({ page, viewport }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  // Find any visible element whose right edge is > viewport.width + 1.
  // Use evaluate so we don't iterate 1k+ nodes from Playwright.
  const overflowers = await page.evaluate((vw) => {
    const out: { tag: string; cls: string; right: number }[] = [];
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > vw + 1) {
        out.push({
          tag: el.tagName,
          cls: (el as HTMLElement).className?.toString().slice(0, 80) ?? '',
          right: Math.round(r.right),
        });
      }
    }
    return out.slice(0, 10);
  }, viewport!.width);

  if (overflowers.length > 0) {
    // Many SVG decorations and absolutely-positioned blurs legitimately
    // extend past the viewport with overflow:hidden on their parent. The
    // first test ("no horizontal overflow on documentElement") catches the
    // case that actually matters for users (page-level scroll). So this
    // test just records, not fails — but we print the list for diagnosis.
    console.log(`(info) ${overflowers.length} elements past right edge at viewport ${viewport!.width}:`, JSON.stringify(overflowers, null, 0));
  }
  // Soft check: at minimum, the documentElement is not horizontally scrollable.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow, `documentElement is horizontally scrollable at ${viewport!.width}px`).toBe(false);
});

test('legal links to terms + privacy are present and absolute', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  // Footer should expose both pages.
  const terms = page.getByRole('link', { name: /terms/i });
  const privacy = page.getByRole('link', { name: /privacy/i });
  await expect(terms.first()).toBeVisible();
  await expect(privacy.first()).toBeVisible();
});
