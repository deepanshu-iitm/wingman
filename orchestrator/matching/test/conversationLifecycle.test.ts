import assert from 'node:assert/strict';
import test from 'node:test';

import {
  nextConversationPhase,
  shouldArchiveConversation,
  shouldEndAfterTurn,
} from '../src/conversationLifecycle.js';

test('archives only a durably completed agent conversation', () => {
  assert.equal(
    shouldArchiveConversation({ status: 'complete', controlMode: 'agent' }),
    true,
  );
  assert.equal(
    shouldArchiveConversation({ status: 'active', controlMode: 'human' }),
    false,
  );
  assert.equal(
    shouldArchiveConversation({ status: 'active', controlMode: 'agent' }),
    false,
  );
  assert.equal(shouldArchiveConversation(undefined), false);
});

test('reserves the final two turns for reciprocal goodbyes', () => {
  assert.equal(nextConversationPhase(0, 6, 14, undefined, false), 'opening');
  assert.equal(nextConversationPhase(5, 6, 14, 'closing', false), 'flowing');
  assert.equal(nextConversationPhase(12, 6, 14, 'continue', false), 'closing');
  assert.equal(nextConversationPhase(8, 6, 14, 'wrapping_up', false), 'closing');
  assert.equal(nextConversationPhase(8, 6, 14, 'continue', true), 'closing');
});

test('ends only after the other persona replies to a closing turn', () => {
  assert.equal(shouldEndAfterTurn('continue', 8, 6), false);
  assert.equal(shouldEndAfterTurn('closing', 5, 6), false);
  assert.equal(shouldEndAfterTurn('closing', 7, 6), true);
});
