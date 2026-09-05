import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldArchiveConversation } from '../src/conversationLifecycle.js';

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
