import assert from 'node:assert/strict';
import test from 'node:test';

import { combineTranscriptSegments } from '../dist/interviewStream.js';

test('combineTranscriptSegments joins provider-finalized answer fragments', () => {
  let answer = combineTranscriptSegments('', 'I prefer a quiet evening');
  answer = combineTranscriptSegments(answer, 'but enjoy movies with friends.');

  assert.equal(
    answer,
    'I prefer a quiet evening but enjoy movies with friends.',
  );
});

test('combineTranscriptSegments does not duplicate cumulative transcripts', () => {
  assert.equal(
    combineTranscriptSegments(
      'I value honesty',
      'I value honesty and direct communication',
    ),
    'I value honesty and direct communication',
  );
});
