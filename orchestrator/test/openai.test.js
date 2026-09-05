import assert from 'node:assert/strict';
import test from 'node:test';

import {
  requestStructuredJson,
  StructuredCompletionError,
} from '../dist/openai.js';

test('requestStructuredJson reports completion-token exhaustion', async () => {
  await assert.rejects(
    () =>
      requestStructuredJson({
        apiKey: 'test-key',
        schemaName: 'test',
        schema: { type: 'object' },
        messages: [{ role: 'user', content: 'test' }],
        fetchImpl: async () =>
          Response.json({
            choices: [{ finish_reason: 'length', message: { content: '' } }],
          }),
      }),
    (error) =>
      error instanceof StructuredCompletionError &&
      error.message.includes('completion token limit')
  );
});
