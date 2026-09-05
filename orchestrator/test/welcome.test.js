import assert from 'node:assert/strict';
import test from 'node:test';

import {
  sendWelcomeEmail,
  validateEmail,
  WelcomeEmailError,
} from '../dist/welcome.js';

test('sendWelcomeEmail sends a branded message without exposing the API key', async () => {
  await sendWelcomeEmail(
    'Friend@Example.com',
    '<Deepanshu>',
    'test-key',
    'Wingman <hello@example.com>',
    async (_input, init) => {
      assert.equal(init?.headers.Authorization, 'Bearer test-key');
      const body = JSON.parse(init?.body);
      assert.deepEqual(body.to, ['friend@example.com']);
      assert.equal(body.from, 'Wingman <hello@example.com>');
      assert.match(body.text, /Hey <Deepanshu>/);
      assert.match(body.html, /Hey &lt;Deepanshu&gt;/);
      return Response.json({ id: 'email_123' });
    },
  );
});

test('validateEmail rejects malformed addresses', () => {
  assert.throws(
    () => validateEmail('not-an-email'),
    (error) => error instanceof WelcomeEmailError && error.status === 400,
  );
});
