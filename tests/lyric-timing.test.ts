import assert from 'node:assert/strict';
import test from 'node:test';
import { currentLyricIndex } from '../src/lib/lyric-timing';
import type { LyricLine } from '../src/lib/types';

test('stage uses acoustic first-word starts and keeps untimed line fallback', () => {
  const lines: LyricLine[] = [
    { text: 'First', start: 2, words: [{ text: 'First', start: 1.6, end: 2.2 }] },
    { text: 'Second', start: 4, words: [{ text: 'Second', start: 4.5, end: 5 }] },
    { text: 'Fallback', start: 7 },
  ];
  assert.equal(currentLyricIndex(lines, 1.5), -1);
  assert.equal(currentLyricIndex(lines, 1.6), 0, 'early aligned onset is visible');
  assert.equal(currentLyricIndex(lines, 4.2), 0, 'approximate line start does not interrupt the previous line');
  assert.equal(currentLyricIndex(lines, 4.5), 1);
  assert.equal(currentLyricIndex(lines, 7), 2);
  assert.equal(currentLyricIndex(lines, 1.7), 0, 'backward seek recomputes the line');
});
