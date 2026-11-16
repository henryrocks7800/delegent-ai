// Phase 11 of the production-readiness programme.
//
// Playwright viewport pack: load the built site at each mobile-equivalent
// width and assert layout/copy invariants that the static scanner cannot
// catch (horizontal overflow, mockup visibility, CTA presence at small
// screens). Static copy contracts continue to live in the website content
// scanner (test/website-content-scanner.test.mjs); this complements it
// without duplicating the assertions.
//
// Run: npm run test:viewports
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  // Reasonable default for CI + local; one retry catches the rare flake
  // from a slow first-load + a still-hot vite preview.
  retries: 1,
  reporter: [
    ['list'],
    // JUnit XML for parity with the Maestro pack evidence pipeline.
    ['junit', { outputFile: 'tests/evidence/viewports-junit.xml' }],
  ],
  outputDir: 'tests/evidence/output',
  webServer: {
    // Build once; preview the dist. The website dev script (`npm run dev`)
    // uses vite hot-reload which is fine but slower; preview is closer to
    // the production user experience and matches what gets shipped.
    command: 'npm run build && npm run preview',
    port: 4173,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    // On the business box there is no bundled Chromium; PW_CHANNEL=chrome runs
    // the pack on the installed Chrome instead of downloading one. Unset in CI.
    channel: process.env.PW_CHANNEL || undefined,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // No video — we don't open visuals in chat anyway.
  },
  // Five canonical viewports from the goal doc Phase 11.
  // Add devices() for default UA / pixel ratio so emulation is realistic.
  // All viewports use Pixel-based (Chrome) device emulation so the
  // single Chromium browser binary covers everything. The width is the
  // actual contract being tested; the engine is incidental. WebKit would
  // need a separate browser install (npx playwright install webkit), and
  // viewport-level overflow / DOM-locator contracts behave identically
  // across engines for this site's static markup.
  projects: [
    { name: '320px',  use: { ...devices['Pixel 5'],     viewport: { width: 320, height: 720 } } },
    { name: '360px',  use: { ...devices['Pixel 5'],     viewport: { width: 360, height: 800 } } },
    { name: '390px',  use: { ...devices['Pixel 7'],     viewport: { width: 390, height: 844 } } },
    { name: '412px',  use: { ...devices['Pixel 7'],     viewport: { width: 412, height: 915 } } },
    { name: '768px',  use: { ...devices['Pixel 7'],     viewport: { width: 768, height: 1024 } } },
  ],
});
