import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VerdictError,
  generateVerdict,
} from '../dist/verdict.js';

const firstPersona = {
  displayName: 'Deepanshu',
  summary: 'A curious software builder.',
  interests: ['software', 'music'],
  values: ['curiosity'],
  socialStyle: 'Prefers small groups.',
};

const secondPersona = {
  displayName: 'Ramesh',
  summary: 'A practical builder who enjoys collaborative projects.',
  interests: ['startups', 'music'],
  values: ['collaboration'],
  socialStyle: 'Enjoys focused conversations.',
};

const history = [
  {
    senderName: 'Deepanshu',
    content: 'What do you enjoy building?',
    source: 'agent',
  },
  {
    senderName: 'Ramesh',
    content: 'Products that help people collaborate.',
    source: 'agent',
  },
];

test('generateVerdict returns a validated score and rationale', async () => {
  const result = await generateVerdict(
    firstPersona,
    secondPersona,
    history,
    'test-key',
    async (_input, init) => {
      const request = JSON.parse(init?.body);
      assert.equal(request.response_format.type, 'json_schema');
      assert.equal(request.max_completion_tokens, 4_000);
      assert.equal(init?.headers.Authorization, 'Bearer test-key');

      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                score: 86,
                rationale:
                  'They share curiosity, music, and an interest in collaborative building.',
              }),
            },
          },
        ],
      });
    }
  );

  assert.deepEqual(result, {
    score: 86,
    rationale:
      'They share curiosity, music, and an interest in collaborative building.',
  });
});

test('generateVerdict requires conversation evidence', async () => {
  await assert.rejects(
    () =>
      generateVerdict(
        firstPersona,
        secondPersona,
        [],
        'test-key'
      ),
    (error) => error instanceof VerdictError && error.status === 400
  );
});

test('generateVerdict rejects scores outside the supported range', async () => {
  await assert.rejects(
    () =>
      generateVerdict(
        firstPersona,
        secondPersona,
        history,
        'test-key',
        async () =>
          Response.json({
            choices: [
              {
                message: {
                  content: '{"score":120,"rationale":"Invalid score"}',
                },
              },
            ],
          })
      ),
    (error) =>
      error instanceof VerdictError &&
      error.message === 'Model returned an invalid compatibility score'
  );
});
