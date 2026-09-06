import assert from 'node:assert/strict';
import test from 'node:test';

import {
  combineTranscriptSegments,
  shouldFinalizeInterview,
} from '../dist/interviewStream.js';

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

test('requires three answers before honoring an early finish request', () => {
  assert.equal(shouldFinalizeInterview(1, true), false);
  assert.equal(shouldFinalizeInterview(2, true), false);
  assert.equal(shouldFinalizeInterview(3, true), true);
});

test('automatically finalizes at the maximum answer count', () => {
  assert.equal(shouldFinalizeInterview(5, false), true);
});
