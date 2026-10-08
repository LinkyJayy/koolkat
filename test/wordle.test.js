import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score, syllables } from '../public/js/wordle.js';
import { ANSWERS, isWord } from '../public/js/wordle-words.js';

test('Kat Wordle scores guesses like Wordle, repeated letters included', () => {
  assert.deepEqual(score('crane', 'crane'), Array(5).fill('correct'));
  assert.deepEqual(score('about', 'twist'), ['absent', 'absent', 'absent', 'absent', 'correct']);
  // Only one L in "light": the second L in "llama"-style guesses is grey.
  assert.deepEqual(score('lolly', 'light'), ['correct', 'absent', 'absent', 'absent', 'absent']);
  assert.deepEqual(score('eerie', 'sheep'), ['present', 'present', 'absent', 'absent', 'absent']);
});

test('every answer is a guessable 5-letter word', () => {
  assert.ok(ANSWERS.length > 500);
  for (const w of ANSWERS) assert.ok(/^[a-z]{5}$/.test(w) && isWord(w), w);
  assert.equal(isWord('zzzzz'), false);
});

test('syllable hint', () => {
  for (const [w, n] of [['smile', 1], ['table', 2], ['piano', 3], ['video', 3], ['house', 1], ['apple', 2], ['ocean', 2], ['quiet', 2], ['dying', 2], ['bread', 1]]) {
    assert.equal(syllables(w), n, w);
  }
});
