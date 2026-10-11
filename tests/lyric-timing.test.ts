import assert from 'node:assert/strict';
import test from 'node:test';
import { currentLyricIndex, gapCountdown, sungLineBefore, sungLinesAfter, wordProgress } from '../src/lib/lyric-timing';
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

test('stage skips instrumental blanks and counts down into the next sung line', () => {
  const lines: LyricLine[] = [
    { text: 'One', start: 10 },
    { text: '  ', start: 12 },
    { text: 'Two', start: 30 },
    { text: 'Three', start: 33 },
  ];
  assert.deepEqual(sungLinesAfter(lines, 0, 2).map((l) => l.text), ['Two', 'Three'], 'blank line is not an upcoming slot');
  assert.deepEqual(sungLinesAfter(lines, -1, 2).map((l) => l.text), ['One', 'Two']);
  assert.equal(sungLineBefore(lines, 2)?.text, 'One');
  assert.equal(sungLineBefore(lines, 0), null);
  assert.equal(gapCountdown(lines, 1, 20), null, 'long gap shows a note before the countdown starts');
  assert.equal(gapCountdown(lines, 1, 25.5), 5);
  assert.equal(gapCountdown(lines, 1, 29.2), 1);
  assert.equal(gapCountdown(lines, -1, 7), 3, 'intro counts down to the first line');
  assert.equal(gapCountdown(lines, 0, 11), null, 'sung line never counts down');
  assert.equal(gapCountdown(lines, 3, 40), null, 'nothing left to count to');
});

test('word progress falls back to the next word, then the line end', () => {
  const line: LyricLine = { text: 'a b c', start: 0, end: 4, words: [{ text: 'a', start: 0, end: 1 }, { text: 'b', start: 2 }, { text: 'c', start: 3 }] };
  assert.equal(wordProgress(line, 0, 0.5), 0.5);
  assert.equal(wordProgress(line, 0, 5), 1);
  assert.equal(wordProgress(line, 1, 1), 0);
  assert.equal(wordProgress(line, 1, 2.5), 0.5, 'untimed end runs to the next word');
  assert.equal(wordProgress(line, 2, 3.5), 0.5, 'last untimed word runs to the line end');
  assert.equal(wordProgress({ ...line, words: [{ text: 'x', start: 1, end: 1 }] }, 0, 1), 1, 'zero-length word is done once reached');
});
