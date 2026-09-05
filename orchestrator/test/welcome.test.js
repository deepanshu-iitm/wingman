import assert from 'node:assert/strict';
import test from 'node:test';

import {
  sendWelcomeEmail,
  validateEmail,
  WelcomeEmailError,
} from '../dist/welcome.js';

test('sendWelcomeEmail sends a branded message through Brevo', async () => {
  await sendWelcomeEmail(
    'Friend@Example.com',
    '<Deepanshu>',
    'test-key',
    'hello@example.com',
    async (_input, init) => {
      assert.equal(init?.headers['api-key'], 'test-key');
      const body = JSON.parse(init?.body);
      assert.deepEqual(body.to, [
        { email: 'friend@example.com', name: '<Deepanshu>' },
      ]);
      assert.deepEqual(body.sender, {
        name: 'Wingman',
        email: 'hello@example.com',
      });
      assert.match(body.textContent, /Hey <Deepanshu>/);
      assert.match(body.htmlContent, /Hey &lt;Deepanshu&gt;/);
      return Response.json({ messageId: 'email_123' });
    },
  );
});

test('validateEmail rejects malformed addresses', () => {
  assert.throws(
    () => validateEmail('not-an-email'),
    (error) => error instanceof WelcomeEmailError && error.status === 400,
  );
});
