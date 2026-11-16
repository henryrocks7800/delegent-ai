// Contract for the in-product help copy (how-to guide + FAQ).
//
// The point of moving this copy into @sidekick/shared is that mobile and web
// render the same words. These tests fail if someone re-declares the copy
// inline in a surface, which is how it would silently drift back apart.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DELEGENT_HOWTO_TITLE,
  DELEGENT_HOWTO_INTRO,
  DELEGENT_HOWTO_SECTIONS,
  DELEGENT_HOWTO_DEEPER_URL,
  DELEGENT_FAQ_ITEMS,
  DELEGENT_FEATURE_FAQ_ITEMS,
  DELEGENT_FAQ_ORDERED,
} from '../dist/index.js';

const mobileApp = readFileSync(
  new URL('../../../apps/mobile/App.tsx', import.meta.url),
  'utf8',
);

test('mobile renders the shared help copy rather than its own copy', () => {
  for (const ident of ['const faqItems', 'const pilotFaqItems', 'const HOWTO_SECTIONS']) {
    assert.ok(
      !mobileApp.includes(ident),
      `apps/mobile/App.tsx re-declares ${ident}; it must import from @sidekick/shared so web and mobile cannot drift`,
    );
  }
  assert.ok(mobileApp.includes('DELEGENT_HOWTO_SECTIONS.map'));
  assert.ok(mobileApp.includes('DELEGENT_FAQ_ORDERED.map'));
});

test('no em dashes anywhere in customer-facing help copy', () => {
  const strings = [
    DELEGENT_HOWTO_TITLE,
    DELEGENT_HOWTO_INTRO,
    ...DELEGENT_HOWTO_SECTIONS.flatMap((section) => [section.title, ...section.body]),
    ...DELEGENT_FAQ_ORDERED.flatMap((item) => [item.question, item.answer]),
  ];
  for (const value of strings) {
    assert.ok(!value.includes('—'), `em dash in help copy: ${value.slice(0, 80)}`);
  }
});

test('every how-to section has a title and at least one paragraph', () => {
  assert.ok(DELEGENT_HOWTO_SECTIONS.length >= 5);
  for (const section of DELEGENT_HOWTO_SECTIONS) {
    assert.ok(section.title.trim().length > 0);
    assert.ok(section.body.length > 0);
    for (const paragraph of section.body) assert.ok(paragraph.trim().length > 0);
  }
});

test('Routines and Connections are both documented in the how-to guide', () => {
  const titles = DELEGENT_HOWTO_SECTIONS.map((section) => section.title.toLowerCase());
  assert.ok(titles.some((title) => title.includes('routine')), 'no Routines how-to section');
  assert.ok(titles.some((title) => title.includes('connect')), 'no Connections how-to section');
});

test('Routines and Connections are both answered in the FAQ', () => {
  const blob = DELEGENT_FAQ_ORDERED.map((item) => `${item.question} ${item.answer}`).join(' ');
  assert.match(blob, /Open Routines in the menu/);
  assert.match(blob, /Open Connections in the menu/);
});

test('FAQ entries are unique and non-empty', () => {
  const questions = DELEGENT_FAQ_ORDERED.map((item) => item.question);
  assert.equal(new Set(questions).size, questions.length, 'duplicate FAQ question');
  for (const item of DELEGENT_FAQ_ORDERED) {
    assert.ok(item.question.trim().length > 0);
    assert.ok(item.answer.trim().length > 0);
  }
});

test('Voice mode leads the FAQ and Telegram closes it', () => {
  assert.equal(DELEGENT_FAQ_ORDERED[0], DELEGENT_FEATURE_FAQ_ITEMS[0]);
  assert.match(DELEGENT_FAQ_ORDERED[0].question, /Voice mode/);
  assert.equal(DELEGENT_FAQ_ORDERED.at(-1), DELEGENT_FEATURE_FAQ_ITEMS[1]);
  assert.match(DELEGENT_FAQ_ORDERED.at(-1).question, /Telegram/);
  assert.equal(DELEGENT_FAQ_ORDERED.length, DELEGENT_FAQ_ITEMS.length + 2);
});

test('the deeper-guide link points at the brand domain, not the API domain', () => {
  assert.ok(DELEGENT_HOWTO_DEEPER_URL.startsWith('https://delegentai.co.uk/'));
});
