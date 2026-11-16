// The drift sink.
//
// Alex found the how-to guide saying different things in the app and in the web
// app: a "using it on your computer" section existed on the phone only. It was
// a deliberate call at the time, which is the point. Nobody has to be careless
// for two surfaces to drift; one reasonable per-surface decision is enough, and
// then it rots quietly because no one reads both copies side by side.
//
// So: any piece of shared copy that only ONE surface renders has to be declared
// here with a reason. Not banned, declared. A decision someone wrote down is
// fine; a decision nobody noticed is what this test exists to stop.
//
// This is a source-text check, not a rendering check. It cannot prove the words
// reach the screen (apps/webapp/test/browser/audit.mjs drives a real browser for
// that). What it does prove is that neither surface can quietly stop sharing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// Declared, with the reason. Read these before adding one: the bar is that a
// reader can tell whether the reason still holds without asking anyone.
const AGENT_ENGINE_ANDROID_FIRST = 'Agent engine accounts (packages/shared/src/content/agentEngine.ts). Alex, 2026-09-15: Android first, then iOS and the web app once the Android implementation is approved, so this copy renders on the phone only until the web release. An agent-engine account in the browser still sees the workspace copy.';

const SURFACE_SPECIFIC = {
  MODEL_CLAIM_SHORT: {
    surface: 'mobile',
    why: `The assistant plan's plan page uses the short claim, because the paywall line promises a private cloud space those accounts do not have. ${AGENT_ENGINE_ANDROID_FIRST}`,
  },
  AGENT_ENGINE_UNSUPPORTED_CONNECTIONS: {
    surface: 'mobile',
    why: AGENT_ENGINE_ANDROID_FIRST,
  },
  AGENT_HOWTO_INTRO: {
    surface: 'mobile',
    why: AGENT_ENGINE_ANDROID_FIRST,
  },
  AGENT_HOWTO_SECTIONS: {
    surface: 'mobile',
    why: AGENT_ENGINE_ANDROID_FIRST,
  },
  AGENT_HOWTO_TITLE: {
    surface: 'mobile',
    why: AGENT_ENGINE_ANDROID_FIRST,
  },
  AGENT_DATA_COPY_NOTE: {
    surface: 'mobile',
    why: AGENT_ENGINE_ANDROID_FIRST,
  },
  agentTopUpConsentBody: {
    surface: 'mobile',
    why: AGENT_ENGINE_ANDROID_FIRST,
  },
  AGENT_BUILT_IN_BADGE: {
    surface: 'mobile',
    why: AGENT_ENGINE_ANDROID_FIRST,
  },
  AGENT_CONNECTIONS_INTRO: {
    surface: 'mobile',
    why: AGENT_ENGINE_ANDROID_FIRST,
  },
  AGENT_TOP_UP: {
    surface: 'mobile',
    why: AGENT_ENGINE_ANDROID_FIRST,
  },
  AGENT_CHECKOUT_THANK_YOU: {
    surface: 'mobile',
    why: AGENT_ENGINE_ANDROID_FIRST,
  },
  assistantWording: {
    surface: 'mobile',
    why: AGENT_ENGINE_ANDROID_FIRST,
  },
  formatTopUpPrice: {
    surface: 'mobile',
    why: AGENT_ENGINE_ANDROID_FIRST,
  },
  agentUseCaseCategories: {
    surface: 'mobile',
    why: AGENT_ENGINE_ANDROID_FIRST,
  },
  APPLE_MANAGE_SUBSCRIPTIONS_URL: {
    surface: 'mobile',
    why: 'The phone opens this itself when the native subscription sheet refuses, so it names the constant. The browser gets the same URL through billingControlsFor().manageUrl rather than naming it, because on the web it is one field of an explanation rather than a destination the surface owns. Same value, one definition, so the two cannot drift.',
  },
  WEB_APP_URL: {
    surface: 'mobile',
    why: 'The menu row that opens the browser version. The web app is already the browser version, so a row pointing at itself would be a dead end. If a "get it on your phone" row is ever added to the browser, this pairs with it.',
  },
  WEB_APP_MENU_LABEL: {
    surface: 'mobile',
    why: 'Label for the same menu row as WEB_APP_URL. The words a reader in the browser needs are in the shared how-to section and the shared FAQ answer, both of which render on both surfaces.',
  },
  WEB_APP_MENU_DETAIL: {
    surface: 'mobile',
    why: 'Detail line for the same menu row as WEB_APP_URL.',
  },
  provisioningNoticeBody: {
    surface: 'mobile',
    why: 'The phone renders the provisioning notice as a single body string; the browser renders title and body separately via gateNotice. Same source data, two shapes. Worth collapsing to one helper, but the copy itself cannot drift because both derive from the same gate kinds.',
  },
  gateNotice: {
    surface: 'web',
    why: 'The browser half of the pair described under provisioningNoticeBody.',
  },
  CHECKOUT_CONFIRMING_MESSAGE: {
    surface: 'web',
    why: 'A sentence, because the browser waits out the webhook on a whole page with room for one. The phone waits inside the setup wizard, where the only surface for it is the button the reader just pressed, and that reads "Confirming subscription…". Both waits run the same poll and end in the same two shared messages, so the outcome cannot drift; only the shape of the waiting state differs.',
  },
  SUBSCRIPTION_ALREADY_ACTIVE_CONFIRMING: {
    surface: 'web',
    why: 'The phone already answers this case, and answers it better: mobileCheckout.ts names the tier ("your Pro subscription is already active. Refreshing now."), which it can do because the wizard knows which plan the reader just pressed. The browser reaches this state from a returning checkout link with no tier in hand, so it says the same thing without the name. If the browser ever learns the tier, fold both into the mobile builder and delete this entry.',
  },
  SUBSCRIPTION_ALREADY_ACTIVE_SLOW_MESSAGE: {
    surface: 'web',
    why: 'The slow-path partner of SUBSCRIPTION_ALREADY_ACTIVE_CONFIRMING, shown once the browser poll has waited and the plan still has not appeared. The phone has no equivalent because its wizard hands back to a screen that re-reads product state on focus, so there is no stuck poll to explain.',
  },
};

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      walk(path, out);
      continue;
    }
    if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry) && !/\.test\./.test(entry)) out.push(path);
  }
  return out;
}

function readSourceGraph(paths, read, resolve) {
  const pending = [...paths], seen = new Set(), sources = [];
  while (pending.length) {
    const path = pending.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    const source = read(path); sources.push(source);
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    for (const node of file.statements) {
      if ((!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node))
        || !node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)
        || node.isTypeOnly || node.importClause?.isTypeOnly) continue;
      const dependency = resolve(node.moduleSpecifier.text, path);
      if (dependency) pending.push(dependency);
    }
  }
  return sources.join('\n');
}

const mobileRoot = join(ROOT, 'apps/mobile/src');
const mobileFiles = new Set(walk(mobileRoot));
const readAll = paths => readSourceGraph(paths, path => readFileSync(path, 'utf8'), (specifier, importer) => {
  // The browser compiles shared logic through @mobile-logic. Count the files
  // actually imported there, including their local dependencies, rather than
  // falsely reporting their shared messages as mobile-only. Do not count all
  // mobile files as web usage, which would hide genuine copy divergence.
  const target = specifier.startsWith('@mobile-logic/') ? join(mobileRoot, specifier.slice('@mobile-logic/'.length))
    : mobileFiles.has(importer) && specifier.startsWith('.') ? join(dirname(importer), specifier) : null;
  return target ? [target, `${target}.ts`, `${target}.tsx`, join(target, 'index.ts'), join(target, 'index.tsx')]
    .find(path => mobileFiles.has(path)) : null;
});

const SURFACES = {
  mobile: readAll([join(ROOT, 'apps/mobile/App.tsx'), ...walk(join(ROOT, 'apps/mobile/src'))]),
  web: readAll(walk(join(ROOT, 'apps/webapp/src'))),
};

const contentDir = join(ROOT, 'packages/shared/src/content');
const EXPORTS = readdirSync(contentDir)
  .filter((file) => file.endsWith('.ts'))
  .flatMap((file) => {
    const text = readFileSync(join(contentDir, file), 'utf8');
    return [...text.matchAll(/^export (?:const|function) ([A-Za-z0-9_]+)/gm)].map((match) => ({
      file,
      name: match[1],
    }));
  });

const usedBy = (name) => {
  const pattern = new RegExp(`\\b${name}\\b`);
  return Object.entries(SURFACES)
    .filter(([, source]) => pattern.test(source))
    .map(([surface]) => surface);
};

test('source parity follows shared runtime imports without counting unrelated mobile code or type-only imports', () => {
  const files = {
    'web.ts': "import { message } from '@mobile-logic/bridge'; import type { Shape } from 'types'; // import 'private';",
    bridge: "export { message } from 'copy';",
    copy: "import 'bridge'; export const message = 'SHARED_RUNTIME_MESSAGE';",
    types: "export const message = 'TYPE_ONLY_MOBILE_MESSAGE';",
    private: "export const message = 'UNUSED_MOBILE_MESSAGE';",
  };
  const sources = readSourceGraph(['web.ts'], path => files[path], specifier => specifier.replace('@mobile-logic/', ''));
  assert.match(sources, /SHARED_RUNTIME_MESSAGE/);
  assert.doesNotMatch(sources, /TYPE_ONLY_MOBILE_MESSAGE|UNUSED_MOBILE_MESSAGE/);
  assert.equal((sources.match(/SHARED_RUNTIME_MESSAGE/g) ?? []).length, 1, 'cyclic imports are visited once');
});

test('the content files actually export something to check', () => {
  assert.ok(EXPORTS.length >= 15, `found only ${EXPORTS.length} shared content exports; the scanner is looking in the wrong place`);
});

test('no shared copy renders on one surface only without a written reason', () => {
  const undeclared = EXPORTS
    .map((entry) => ({ ...entry, surfaces: usedBy(entry.name) }))
    .filter((entry) => entry.surfaces.length === 1 && !SURFACE_SPECIFIC[entry.name]);

  assert.deepEqual(
    undeclared.map((entry) => `${entry.name} (${entry.file}, ${entry.surfaces[0]} only)`),
    [],
    'These bits of shared copy reach one surface and not the other. That is how the app and the web app start saying different things. ' +
      'Either render them on both, or add them to SURFACE_SPECIFIC in this file with the reason.',
  );
});

test('a declared exception that is no longer one has to be taken out of the list', () => {
  // Otherwise the list slowly fills with reasons that stopped being true, and a
  // real divergence hides among them.
  const stale = Object.keys(SURFACE_SPECIFIC).filter((name) => usedBy(name).length !== 1);
  assert.deepEqual(
    stale,
    [],
    'These are listed as surface-specific but both surfaces now use them (or neither does). Remove them from SURFACE_SPECIFIC.',
  );
});

test('every declared exception names the surface and says why', () => {
  for (const [name, entry] of Object.entries(SURFACE_SPECIFIC)) {
    assert.ok(Object.keys(SURFACES).includes(entry.surface), `${name} names an unknown surface ${entry.surface}`);
    assert.deepEqual(usedBy(name), [entry.surface], `${name} is declared as ${entry.surface}-only but is used by ${usedBy(name).join(', ') || 'neither surface'}`);
    assert.ok(
      entry.why && entry.why.length > 40,
      `${name} is declared surface-specific with no real reason. A reason nobody can check is the same as no reason.`,
    );
  }
});

test('the how-to guide and the FAQ are rendered from the shared lists on both surfaces', () => {
  // The guide drifted by growing an EXTRA card on the phone, outside the shared
  // list, so "both surfaces map the list" is the thing to hold: an extra card is
  // then visible as an undeclared one-surface export in the test above.
  const help = readFileSync(join(ROOT, 'apps/webapp/src/features/help/HelpScreen.tsx'), 'utf8');
  for (const [surface, source] of [['mobile', SURFACES.mobile], ['web', help]]) {
    assert.match(source, /DELEGENT_HOWTO_SECTIONS\.map/, `${surface} does not render the shared how-to sections`);
  }
  assert.match(SURFACES.mobile, /DELEGENT_FAQ_ORDERED\.map/, 'mobile does not render the shared FAQ');
  assert.match(SURFACES.web, /DELEGENT_FAQ_ORDERED/, 'the web app does not render the shared FAQ');
});
