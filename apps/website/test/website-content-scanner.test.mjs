// Static source-scanner for the marketing website.
//
// Phase 12 of the exhaustive test goal. Replaces the "screenshot the
// page and look at it" workflow for the content/copy invariants the
// goal doc enumerates. The viewport-overflow + layout checks need a
// real browser (Playwright) - see docs/mobile-lab/WEBSITE_MOBILE.md
// for the follow-up path; this file covers everything that DOESN'T
// need a browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEBSITE_ROOT = resolve(__dirname, '..');
const SRC = join(WEBSITE_ROOT, 'src');
const STATIC_PUBLIC_COPY_FILES = [join(WEBSITE_ROOT, 'index.html')];

function walkSources(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkSources(full));
    } else if (/\.(tsx?|css|html)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const sources = [...walkSources(SRC), ...STATIC_PUBLIC_COPY_FILES];
const sourceTextByFile = Object.fromEntries(
  sources.map((p) => [p, readFileSync(p, 'utf8')]),
);
const allText = Object.values(sourceTextByFile).join('\n');

test('website: Telegram/WhatsApp/Signal mentions outside the chat mockup are limited to the FAQ "messengers roadmap" position', () => {
  // The TelegramMock component is a UI demo - allowed to mention
  // Telegram by name. The FAQ.tsx file legitimately references
  // Telegram/WhatsApp/Signal as STAGED/COMING-SOON messenger options
  // per the May 2026 positioning. Both are scoped exceptions.
  // Any other file referencing these by name is a positioning bug.
  // FAQ.tsx, ValueProps.tsx — both carry the intentional "in-app chat
  // today, messengers staged" positioning copy that the May 2026
  // alignment work landed (see SESSION_HANDOFF_CURRENT.md Batch 25).
  // Both legitimately name the messengers by name as a roadmap signal,
  // NOT a positioning claim.
  const allowedFiles = new Set(['TelegramMock.tsx', 'FAQ.tsx', 'ValueProps.tsx']);
  for (const [path, text] of Object.entries(sourceTextByFile)) {
    // Split on BOTH separators: walkSources builds paths with node:path.join,
    // so on Windows they use "\" and split('/') returns the whole path as one
    // element. The allow-list then never matches and FAQ.tsx is flagged as a
    // positioning bug in its own file.
    const base = path.split(/[\\/]/).pop();
    if (allowedFiles.has(base)) continue;
    // Identifier-style refs (component names, imports) are fine; only
    // bare-word mentions in copy are the signal.
    const m = text.match(/\b(Telegram|WhatsApp|Signal Messenger)\b[^a-zA-Z0-9_]/);
    if (m) {
      assert.fail(`${path} mentions "${m[1]}" in user-facing copy outside the allowed FAQ/Mock context`);
    }
  }
});

test('website: no "UK servers" / "hosted in the UK" / "British servers" unsupported claims', () => {
  // The infrastructure runs on Cloudflare Workers + Fly Machines, which
  // are global. Claiming UK servers is a regulatory misstatement.
  assert.doesNotMatch(allText, /\bUK\s+servers?\b/i, 'unsupported "UK servers" claim');
  assert.doesNotMatch(allText, /\bhosted\s+in\s+the\s+UK\b/i);
  assert.doesNotMatch(allText, /\bBritish\s+servers?\b/i);
  assert.doesNotMatch(allText, /\bdata\s+stays\s+in\s+the\s+UK\b/i);
});

test('website: company identity is "Delegent AI" not the old "Sidekick" / "Coworker AI"', () => {
  // The Ltd company identity work in Batches 20-27 settled on
  // "Delegent AI" (or "Delegent AI") as the canonical legal
  // name. The footer is the source of truth.
  const footerPath = sources.find((p) => p.endsWith('Footer.tsx'));
  assert.ok(footerPath, 'expected Footer.tsx to exist');
  const footer = sourceTextByFile[footerPath];
  assert.match(footer, /Delegent\s+AI/);
  // The old names must NOT be in user-facing surfaces.
  for (const [path, text] of Object.entries(sourceTextByFile)) {
    if (/\bSidekick\b/.test(text) && !/^(?:\/\*|\s*\/\/)/m.test(text)) {
      // Allow comments but not user-facing strings. Cheap heuristic:
      // "Sidekick" inside a JSX text node or string literal is a hit.
      const m = text.match(/(>[^<{}]*\bSidekick\b[^<{}]*<|"[^"\n]*\bSidekick\b[^"\n]*")/);
      if (m) assert.fail(`${path}: user-facing "Sidekick" string: ${m[0]}`);
    }
    assert.doesNotMatch(text, /\bCoworker AI Ltd\b/i, `${path}: old "Coworker AI Ltd" company name`);
  }
});

test('website: only the 4 real mailboxes (contact/support/accounts/admin @delegentai.co.uk) are referenced', () => {
  // Per memory: contact, support, accounts, admin. No invented
  // addresses like privacy@, hello@, info@, legal@.
  const allowedLocals = new Set(['contact', 'support', 'accounts', 'admin']);
  // Match `<local>@delegentai.co.uk` and `<local>@delegent.ai`.
  const mailboxRegex = /\b([a-z][a-z0-9._-]{0,40})@(?:delegentai\.co\.uk|delegent\.ai)/gi;
  for (const [path, text] of Object.entries(sourceTextByFile)) {
    for (const m of text.matchAll(mailboxRegex)) {
      const local = m[1].toLowerCase();
      assert.ok(
        allowedLocals.has(local),
        `${path}: unexpected mailbox local-part "${local}" — only ${[...allowedLocals].join(',')} are allowed`,
      );
    }
    // Block the old @delegent.ai domain entirely in user-facing copy
    // (Batches 20+ migrated to @delegentai.co.uk).
    assert.doesNotMatch(text, /@delegent\.ai\b/, `${path}: old @delegent.ai domain (migrate to @delegentai.co.uk)`);
  }
});

test('website: chat mockup matches app design tokens (DOM-class alignment, no inline screenshot)', () => {
  // The TelegramMock (now strictly a styling demo per v1.2.1) and any
  // other chat-mockup component must use the same colour tokens the
  // app uses on the chat bubble. Cheap structural assertion: the
  // mockup file references the warm-off-white surface tone via a
  // recognisable Tailwind class OR the design-token name.
  const mockPath = sources.find((p) => p.endsWith('TelegramMock.tsx'));
  if (mockPath) {
    const mock = sourceTextByFile[mockPath];
    // Either Tailwind class for the off-white surface OR a literal
    // hex matching colors.surface.
    assert.ok(
      /bg-(?:warm-|stone-|neutral-|ivory|cream|off|delegent-|brand-|sage)/i.test(mock)
        || /#[fF][7-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]/.test(mock),
      'TelegramMock has neither a warm-tone Tailwind class nor a near-white hex',
    );
  }
});

test('website: no raw provider/runtime leak strings in user-facing copy', () => {
  // Same defensive check as the mobile renderer: even an "honest"
  // copy line that mentions HTTP 502 or hermes --resume by accident
  // would confuse the marketing audience.
  for (const [path, text] of Object.entries(sourceTextByFile)) {
    assert.doesNotMatch(text, /\bHTTP\s+5\d\d\b/, `${path}: HTTP 5xx leak`);
    assert.doesNotMatch(text, /hermes\s+--resume/, `${path}: hermes --resume leak`);
    assert.doesNotMatch(text, /\bservice_role\b/, `${path}: service_role mention`);
    assert.doesNotMatch(text, /OPENROUTER_API_KEY|SUPABASE_SERVICE_ROLE_KEY/, `${path}: secret name in source`);
  }
});

test('website: provisioning copy does not promise a precise sub-minute ready workspace before a live SLA exists', () => {
  // The Fly Machines path creates an app, allocates IPs, creates a volume,
  // creates a machine, then allows a 60s health grace period plus a retry
  // loop before the workspace is marked ready. Until production telemetry
  // proves a tighter SLA, public copy must avoid promising exact minute-level
  // readiness and should instead match the app's honest "setting up / coming
  // online" states.
  const howItWorksPath = sources.find((p) => p.endsWith('HowItWorks.tsx'));
  assert.ok(howItWorksPath, 'expected HowItWorks.tsx to exist');
  const valuePropsPath = sources.find((p) => p.endsWith('ValueProps.tsx'));
  assert.ok(valuePropsPath, 'expected ValueProps.tsx to exist');
  const provisioningCopy = [sourceTextByFile[howItWorksPath], sourceTextByFile[valuePropsPath]].join('\n');

  const unsupportedProvisioningSpeedClaims = [
    /\bunder\s+a\s+minute\b/i,
    /\babout\s+three\s+minutes\b/i,
    /\bready\s+in\s+(?:under|less\s+than|about)?\s*\d+\s*(?:seconds?|minutes?)\b/i,
    /\bprovisioned\s+[^.]{0,120}\bin\s+(?:under|less\s+than|about)?\s*\d+\s*(?:seconds?|minutes?)\b/i,
    /\bkeep\s+it\s+ready\s+in\s+the\s+background\b/i,
  ];
  for (const re of unsupportedProvisioningSpeedClaims) {
    assert.doesNotMatch(provisioningCopy, re, `Website promises unsupported provisioning/readiness speed: ${re}`);
  }

  // 2026-09-15: the assistant plan has no workspace to provision, so the steps
  // must say it is ready straight away rather than promise a setup wait.
  assert.match(sourceTextByFile[howItWorksPath], /nothing to set up|ready as soon as you are/i,
    'HowItWorks should say the assistant needs no setup');
});

test('website: active copy does not promise direct Files-tab receipt/PDF upload before bytes-to-runner upload exists', () => {
  // The Android app can list/download runner files and can inline small
  // readable chat attachments. It cannot yet upload arbitrary receipt
  // photos or PDFs into the runner workspace; the production manifest
  // keeps `chat.attachment_bytes_to_runner` blocked until signed runner
  // uploads ship. Public copy must not sell that blocked flow as live.
  const forbiddenActiveClaims = [
    /\bdrag\s+receipt\s+photos\s+and\s+PDF\s+invoices\s+into\b/i,
    /\bPhotos\s+and\s+PDFs\s+accepted\b/i,
    /\breads\s+the\s+receipts\s+using\s+vision\s+tools\b/i,
    /\bthe\s+Files\s+tab\s+in\s+the\s+app\b/i,
  ];
  for (const re of forbiddenActiveClaims) {
    assert.doesNotMatch(allText, re, `public copy over-promises an unshipped upload/vision flow: ${re}`);
  }
});

test('website: use-case examples do not promise direct third-party writes before integrations exist', () => {
  // The shipped Android flow is chat + small readable attachments + the
  // runner Files workspace. There is no live Gmail/Calendar/Shopify/Xero
  // setup path in the production mobile journey yet, so public examples
  // must not sell direct inbox starring, calendar writes, Shopify/courier
  // reconciliation, or accounting-package writes as automatic outcomes.
  const useCasesPath = sources.find((p) => p.endsWith('UseCases.tsx'));
  assert.ok(useCasesPath, 'expected UseCases.tsx to exist');
  const useCases = sourceTextByFile[useCasesPath];
  const unsupportedActiveClaims = [
    /\bMettle\s+transactions\b/i,
    /\bFreeAgent\b/i,
    /\bDrafts\s+waiting\s+in\s+your\s+Gmail\b/i,
    /\bAngry\s+ones\s+starred\b/i,
    /\bDeadlines\s+already\s+in\s+your\s+week\b/i,
    /\bShopify\s+orders\b/i,
    /\bcourier\s+tracking\s+pings\b/i,
    /\bXero\s+template\b/i,
  ];
  for (const re of unsupportedActiveClaims) {
    assert.doesNotMatch(useCases, re, `UseCases over-promises an unshipped direct integration/write flow: ${re}`);
  }
  assert.match(useCases, /Files/i, 'UseCases should anchor outcomes in the shipped Files workspace');
  assert.match(useCases, /review/i, 'UseCases should keep human-review language for external send/file/approval steps');
});

test('website: persona cards do not promise unshipped direct automation or external writes', () => {
  // Persona copy is close to the top of the homepage and sets strong
  // expectations for developers, small-business owners, and consumers.
  // Until the app has a proven direct upload/connect/scheduled-write path
  // for each external system, persona examples must stay in the same
  // current contract as the rest of the site: user-provided context,
  // reviewable workspace artefacts, and explicit user approval for external
  // pushes/sends/filings.
  const personasPath = sources.find((p) => p.endsWith('Personas.tsx'));
  assert.ok(personasPath, 'expected Personas.tsx to exist');
  const personas = sourceTextByFile[personasPath];
  const unsupportedPersonaClaims = [
    /\bFeed\s+raw\s+code\s+into\s+a\s+secure\s+folder\b/i,
    /\bcommits\s+verified\s+patches\s+back\s+to\s+the\s+repositories\s+you\s+connect\b/i,
    /\bConnect\s+a\s+Shopify\s+or\s+Stripe\s+account\b/i,
    /\btrack\s+competitor\s+pricing\s+via\s+browser\s+automation\b/i,
    /\badjust\s+storefront\s+margins\s+on\s+a\s+schedule\b/i,
    /\bTier-2\s+support\s+flows\b/i,
    /\bdirect\s+browser\s+automation\b/i,
    /\bcontesting\s+unfair\s+parking\s+tickets\b/i,
    /\bfiling\s+insurance\s+claims\b/i,
    /\bnegotiating\s+calendar\s+schedules\b/i,
  ];
  for (const re of unsupportedPersonaClaims) {
    assert.doesNotMatch(personas, re, `Personas over-promises an unshipped external/direct automation flow: ${re}`);
  }
  assert.match(personas, /review/i, 'Personas should keep review/approval language for external actions');
  assert.match(personas, /workspace/i, 'Personas should anchor tangible outputs in the shipped workspace');
});

test('website: public copy does not promise unattended recurring/scheduled jobs before a user scheduler exists', () => {
  // The current shipped product lets users chat, provide files/text, save
  // repeatable instructions, and review artefacts in Files. There is no live
  // user-facing scheduler that creates future task_runs without a fresh user
  // message. Until that exists, website copy and chat mockups must not sell
  // "every Monday", "after hours", reminders, or recurring jobs that "just
  // happen" as automatic outcomes.
  const unsupportedUnattendedWorkClaims = [
    /\bBrief\s+once,\s+repeat\s+forever\b/i,
    /\bEvery\s+Monday\b/i,
    /\bRecurring\s+jobs?\b/i,
    /\brecurring\s+job\b/i,
    /\bwatch\s+for\s+events\s+on\s+a\s+schedule\b/i,
    /\bon\s+the\s+right\s+cadence\b/i,
    /\bthat\s+just\s+happen\b/i,
    /\beven\s+after\s+hours\b/i,
    /\bquiet\s+reminder\b/i,
    /\bset\s+a\s+quiet\s+reminder\b/i,
  ];
  for (const re of unsupportedUnattendedWorkClaims) {
    assert.doesNotMatch(allText, re, `public copy promises unattended scheduled/recurring work before it exists: ${re}`);
  }
  assert.match(allText, /repeatable/i, 'website should frame repeat work as repeatable workflows/checklists/recipes today');
  assert.match(allText, /review/i, 'website should keep human review language around external sends and follow-ups');
});

test('website: FAQ explains supported connections and explicit user authorization', () => {
  // The production Connections screen supports brokered sign-in (START_HERE
  // section 3). The old manual-only assertion contradicted that shipped path.
  // This still must not promise arbitrary integrations or automatic accounts.
  const faqPath = sources.find((p) => p.endsWith('FAQ.tsx'));
  assert.ok(faqPath, 'expected FAQ.tsx to exist');
  const faq = sourceTextByFile[faqPath];

  const unsupportedConnectionClaims = [
    /\bwhere\s+the\s+service\s+has\s+an\s+API\s+or\s+sign-in\s+path\b/i,
    /\bseparate\s+inbox\s+like\s+AgentMail\b/i,
  ];
  for (const re of unsupportedConnectionClaims) {
    assert.doesNotMatch(faq, re, `FAQ over-promises a live generic integration/inbox path: ${re}`);
  }

  assert.match(faq, /Open Connections.*supported services/i,
    'FAQ should explain the supported connection path');
  assert.match(faq, /sign in and approve access/i,
    'connecting requires explicit user authorization');
  assert.match(faq, /access you grant/i,
    'connected work is limited to the permissions granted');
  assert.match(faq, /cannot create accounts/i,
    'provider account creation must not be promised');
});

test('website: trust copy does not imply live connected-account operations before integrations exist', () => {
  // Trust copy is high-leverage because users read it as the safety model.
  // The shipped product currently supports chat, files, copied/forwarded
  // context, scoped details, and manual setup guidance, not a live account
  // connection surface or delegated secret-rotation service for user systems.
  const trustPath = sources.find((p) => p.endsWith('Trust.tsx'));
  assert.ok(trustPath, 'expected Trust.tsx to exist');
  const trust = sourceTextByFile[trustPath];

  const unsupportedTrustClaims = [
    /\bacts\s+through\s+the\s+accounts\s+you\s+connect\b/i,
    /\baccounts\s+you\s+connect\b/i,
    /\brotate\s+sensitive\s+access\b/i,
    /\bwe\s+[^.]{0,80}\brotate\s+[^.]{0,80}\baccess\b/i,
  ];
  for (const re of unsupportedTrustClaims) {
    assert.doesNotMatch(trust, re, `Trust copy implies an unshipped connected-account/secret-rotation flow: ${re}`);
  }

  assert.match(trust, /scoped\s+details|context\s+you\s+choose|setup\s+guidance|you\s+control/i,
    'Trust copy should describe user-controlled context/setup, not live account connections');
});

test('website: canonical install/download surface is reachable', () => {
  // The install bundle currently lives at the Firebase Hosting URL
  // (your-firebase-project.web.app — the immutable Firebase *project* id, not a
  // brand domain), distributed out-of-band. The website surfaces the
  // canonical brand domain (delegentai.co.uk). Either reference satisfies
  // the contract: the user has a path forward from the marketing site to
  // "actually get the app".
  assert.ok(
    /your-firebase-project\.web\.app|delegentai\.co\.uk|Install on Android|Get the app/i.test(allText),
    'expected a reference to the install/download URL OR a Get-the-app CTA',
  );
});

test('website: Built-in skills section exists with the seven canonical categories', () => {
  // Phase 6 of the production-readiness programme. The website must
  // surface the agent's skills library so prospective users can see
  // what is available on day one. The component lives in
  // sections/BuiltInSkills.tsx and is wired into App.tsx between
  // UseCases and Pricing.
  const builtInPath = sources.find((p) => p.endsWith('BuiltInSkills.tsx'));
  assert.ok(builtInPath, 'expected sections/BuiltInSkills.tsx to exist');
  const builtIn = sourceTextByFile[builtInPath];

  // Section heading exists.
  assert.match(builtIn, /Already skilled for real work|Built-in skills|What your (assistant|coworker) can help with from day one/i,
    'BuiltInSkills must carry the canonical "Already skilled" / "Built-in skills" heading');

  // The canonical business use-case categories must appear. These mirror the
  // in-app "Skills & use cases" drawer so the site and the product tell the
  // same story, which is the whole point of the check.
  //
  // 2026-09-03: dropped to SEVEN. "Technical & developer" was removed from the
  // in-app drawer on 2026-07-24 and this list was never updated, so for six
  // weeks the site was required to advertise a category the product does not
  // have. That is the exact drift this test exists to catch, pointing the wrong
  // way. The seven below are the drawer's real first layer, which Alex asked to
  // keep unchanged on 2026-09-03.
  // 2026-09-15: the assistant plan's categories, read from the same shared
  // source as the app (agentUseCaseCategories), so they cannot drift.
  assert.match(builtIn, /import \{ agentUseCaseCategories \} from '@sidekick\/shared';/,
    'BuiltInSkills must read its categories from the app list');
  assert.match(builtIn, /\{cat\.title\}/);

  // Wired into App.tsx.
  const appPath = sources.find((p) => p.endsWith('App.tsx'));
  assert.ok(appPath, 'expected App.tsx');
  assert.match(sourceTextByFile[appPath], /<BuiltInSkills\s*\/>/, 'App.tsx must render <BuiltInSkills />');
  assert.match(sourceTextByFile[appPath], /from\s+['"]\.\/sections\/BuiltInSkills['"]/,
    'App.tsx must import BuiltInSkills from sections/');
});

test('website: Built-in skills section honours the public-copy safety contract', () => {
  // The skills section must NOT overclaim what the agent does on its own.
  // Concretely it must NOT say it opens bank accounts autonomously, makes
  // payments without approval, files official forms without approval, or
  // replaces regulated professionals. It MUST include a safety paragraph
  // that states the same in the positive direction.
  const builtInPath = sources.find((p) => p.endsWith('BuiltInSkills.tsx'));
  if (!builtInPath) return; // tested above; this test is the content contract
  const builtIn = sourceTextByFile[builtInPath];

  // Active-claim phrases that would be overclaims. Each is anchored to
  // present-tense third-person ("opens", "makes", "submits", "replaces")
  // so the legitimate negative safety phrasing ("does not open / make /
  // submit / replace ...") is not flagged.
  const FORBIDDEN = [
    /\bopens\s+bank\s+accounts?\s+(?:on\s+your\s+behalf|autonomously)/i,
    /\bmakes\s+payments?\s+without\s+(?:your\s+)?approval/i,
    /\bsubmits\s+(?:official\s+)?(?:filings?|forms?)\s+without\s+(?:your\s+)?approval/i,
    /\breplaces\s+(?:your\s+)?(?:accountant|solicitor|lawyer|doctor|therapist)/i,
  ];
  for (const re of FORBIDDEN) {
    assert.doesNotMatch(builtIn, re, `BuiltInSkills overclaims: ${re}`);
  }

  // Required safety-note language.
  assert.match(builtIn, /does not (?:open|make|submit)/i,
    'BuiltInSkills must include the "does not open/make/submit X" safety line');
});

test('website: Built-in skills section stays inside shipped v1 communication and tool-access limits', () => {
  // The website's BuiltInSkills section is introduced as what the assistant
  // can help with "from day one". It must not turn guide/setup skills into
  // claims that a new user already has live tool connections, unattended
  // recurring admin, a provisioned assistant inbox, or a routed phone number.
  const builtInPath = sources.find((p) => p.endsWith('BuiltInSkills.tsx'));
  if (!builtInPath) return;
  const builtIn = sourceTextByFile[builtInPath];

  const unsupportedDayOneClaims = [
    /\bset\s+up\s+and\s+use\s+your\s+(?:bookkeeping\s+and\s+accounting\s+)?tools\b/i,
    /\brecurring\s+admin\b/i,
    /\bchasing\s+on\s+your\s+cadence\b/i,
    /\bhas\s+its\s+own\s+email\s+address\b/i,
    /\bDedicated\s+assistant\s+email\s+address\b/i,
    /\bbusiness\s+phone\s+number\s+that\s+routes\s+through\s+to\s+you\b/i,
  ];
  for (const re of unsupportedDayOneClaims) {
    assert.doesNotMatch(builtIn, re, `BuiltInSkills sells an unshipped day-one integration/cadence claim: ${re}`);
  }

  assert.match(builtIn, /pasted|forwarded|exports|review/i,
    'BuiltInSkills should anchor day-one work in supplied context, exports, and reviewable outputs');
});

test('website: no em-dash characters in BuiltInSkills (release-gate scanner mirror)', () => {
  // The repo-wide em-dash scanner runs separately; this is a per-file
  // sanity check so a regression in just this new section surfaces
  // here too without having to run the global pass.
  const builtInPath = sources.find((p) => p.endsWith('BuiltInSkills.tsx'));
  if (!builtInPath) return;
  const builtIn = sourceTextByFile[builtInPath];
  // U+2014 EM DASH and U+2013 EN DASH.
  assert.doesNotMatch(builtIn, /[—–]/, 'BuiltInSkills.tsx contains em-dash or en-dash');
});

test('website: hero copy strings (excluding Tailwind class lists) stay under 80 chars', () => {
  const heroPath = sources.find((p) => p.endsWith('Hero.tsx'));
  if (!heroPath) {
    // Hero might be inline in App.tsx; skip rather than fail.
    return;
  }
  const hero = sourceTextByFile[heroPath];
  // Find string literals; filter out Tailwind class lists and URLs.
  // A Tailwind class list is the value of a className= prop (or a
  // template literal). Detected by presence of typical TW tokens like
  // bg-/text-/w-/h-/rounded-/blur-/pointer-/animate-.
  const TW_PATTERN = /\b(bg|text|w|h|rounded|blur|pointer|animate|absolute|relative|flex|grid|gap|p[xytrbl]|m[xytrbl]|font|leading|tracking|opacity|z|inset|top|left|right|bottom|border|hover|focus|sm|md|lg|xl|2xl)-/;
  const longStrings = (hero.match(/"[^"\n]{80,}"/g) || []).filter((s) => {
    if (/^"https?:|^"@\/|^"\.{1,2}\//.test(s)) return false; // URLs / imports
    if (TW_PATTERN.test(s)) return false; // Tailwind class list
    return true;
  });
  assert.equal(
    longStrings.length,
    0,
    `Hero has copy string(s) over 80 chars (mobile-overflow risk): ${longStrings.slice(0, 3).join(', ')}`,
  );
});

test('website: the header offers a way into the web app at phone widths too', () => {
  // A returning customer who does not want to install anything has to be able
  // to find the browser version from the front page. This shipped once as a
  // transparent, desktop-only "Sign in" link and went unnoticed for long
  // enough that it was reported as missing entirely.
  const headerPath = sources.find((p) => p.endsWith('Header.tsx'));
  assert.ok(headerPath, 'Header.tsx not found');
  const header = sourceTextByFile[headerPath];

  const links = [...header.matchAll(/<a href=\{WEB_APP_URL\}([\s\S]*?)<\/a>/g)].map((m) => m[1]);
  assert.ok(links.length > 0, 'the header does not link to the web app at all');

  // At least one of them has to survive a 390px viewport.
  const shownOnPhone = links.filter((link) => !/hidden sm:/.test(link));
  assert.ok(
    shownOnPhone.length > 0,
    'every web app link in the header is hidden on phones, so a phone visitor cannot see one',
  );

  // And the reader has to be told where it goes, not just "Sign in".
  assert.match(header, /Log in to the web app/, 'nothing in the header names the web app');
});

test('website: platform availability copy does not call the web app unreleased', () => {
  // It is live and the header links to it, so "web coming next" reads as a
  // contradiction on the same screen. "iOS and web are next" survived the
  // first version of this check, which only looked for the exact phrase.
  assert.doesNotMatch(allText, /web\s+coming\s+next/i, 'copy still describes the web app as unreleased');
  assert.doesNotMatch(allText, /\bweb\s+(?:is|are)\s+next\b/i, 'copy still describes the web app as unreleased');
});

test('website: nothing offers a Windows desktop download', () => {
  // There is no Windows build and no /windows page. The FAQ used to send
  // readers to delegentai.co.uk/windows, which is a dead end and a promise we
  // cannot keep. A forward-looking "coming next" is fine; a download is not.
  assert.doesNotMatch(allText, /delegentai\.co\.uk\/windows/i, 'links to a Windows download that does not exist');
  assert.doesNotMatch(allText, /download\s+the\s+desktop\s+app/i, 'offers a desktop app download that does not exist');
});

test('website: a reader asking about their computer is pointed at the web app', () => {
  // The browser version is the answer to "can I use this on a PC", and it is
  // the answer people scan the FAQ and the getting-started guide for.
  const faqPath = sources.find((p) => p.endsWith('FAQ.tsx'));
  const faq = sourceTextByFile[faqPath];
  // These sources are CRLF, so anchor on whitespace runs rather than \n.
  const devices = faq.match(/q: 'Which devices can I use it on\?',\s+a: ([\s\S]*?),\s+\},/);
  assert.ok(devices, 'the "which devices" FAQ entry is gone or was renamed');
  assert.match(devices[1], /WEB_APP_DISPLAY_URL/, 'the devices answer does not name the web app address');

  // The sentence itself moved into @sidekick/shared on 2026-08-15 so that the
  // site, the web app and the mobile FAQ cannot disagree about which platforms
  // we claim. Follow it there rather than deleting the guarantee: what matters
  // is that a desk reader is still told how to get in, wherever the words live.
  const availability = readFileSync(
    resolve(WEBSITE_ROOT, '../../packages/shared/src/content/platformAvailability.ts'),
    'utf8',
  );
  assert.match(availability, /sign in the same way/i, 'the devices answer does not tell them how to get in');
  assert.match(
    availability,
    /export function supportedDevicesSentence/,
    'the shared devices sentence is gone or was renamed',
  );

  // Normalise separators: on Windows these paths use "\", so a literal
  // 'content/guides.ts' suffix never matches and guidesPath is undefined,
  // which surfaces as the misleading "the guide never mentions the browser
  // version" rather than "the file was not found".
  const guidesPath = sources.find((p) => p.replace(/\\/g, '/').endsWith('content/guides.ts'));
  const guides = sourceTextByFile[guidesPath];
  assert.match(guides, /WEB_APP_DISPLAY_URL/, 'the getting-started guide never mentions the browser version');
  assert.match(guides, /sign in the same way/i, 'the guide does not tell a desk reader how to get in');
});

test('website: the web app address matches the one the apps ship', () => {
  // The website is a standalone Vite build, so it cannot import
  // @sidekick/shared and keeps its own copy of the address. When
  // app.delegentai.co.uk finishes verifying, both have to move together or
  // half the product points at the old door.
  const shared = readFileSync(
    resolve(WEBSITE_ROOT, '../../packages/shared/src/content/webApp.ts'),
    'utf8',
  );
  const sharedUrl = shared.match(/export const WEB_APP_URL = '([^']+)'/);
  const websiteUrl = sourceTextByFile[sources.find((p) => p.endsWith('webAppLink.ts'))].match(
    /export const WEB_APP_URL = '([^']+)'/,
  );
  assert.ok(sharedUrl && websiteUrl, 'WEB_APP_URL is not declared where both sides expect it');
  assert.equal(websiteUrl[1], sharedUrl[1], 'the website and the apps point at different web app addresses');
});
