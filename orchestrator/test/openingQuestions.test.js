import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OPENING_QUESTIONS,
  randomOpeningQuestion,
} from '../dist/openingQuestions.js';

test('provides exactly 100 unique, concise opening questions', () => {
  assert.equal(OPENING_QUESTIONS.length, 100);
  assert.equal(new Set(OPENING_QUESTIONS).size, 100);
  assert.ok(
    OPENING_QUESTIONS.every(
      (question) => question.endsWith('?') && question.length <= 180,
    ),
  );
});

test('selects an opening question from the curated list', () => {
  assert.ok(OPENING_QUESTIONS.includes(randomOpeningQuestion()));
});
