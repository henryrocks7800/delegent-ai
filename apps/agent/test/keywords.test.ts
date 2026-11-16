import assert from 'node:assert/strict';
import test from 'node:test';
import { recallKeywords } from '../src/keywords.ts';

test('recall searches the meaningful words of a question, not the whole sentence', () => {
  assert.deepEqual(recallKeywords('Which supplier did I mention before the fresh chat?'), ['supplier']);
  assert.deepEqual(recallKeywords('What was the £420 quote from Dave the plumber?'), ['£420', 'quote', 'dave', 'plumber']);
  assert.deepEqual(recallKeywords('hi'), []);
});
