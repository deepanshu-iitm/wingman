import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PersonaExtractionError,
  extractPersona,
} from '../dist/persona.js';

const userAnswer =
  'I enjoy building software, meeting curious people, and working in small groups.';
const transcript = `Wingman: What do you enjoy doing?\nUser: ${userAnswer}`;

test('extractPersona returns a validated draft and preserves the supplied name', async () => {
  const draft = await extractPersona(
    transcript,
    'Deepanshu',
    'test-key',
    async (_input, init) => {
      const request = JSON.parse(init?.body);
      assert.equal(request.model, 'gpt-5.6-luna');
      assert.equal(request.response_format.type, 'json_schema');
      assert.equal(init?.headers.Authorization, 'Bearer test-key');

      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: 'A curious software builder.',
                interests: [' software ', 'hackathons', 'software'],
                values: ['curiosity'],
                socialStyle: 'Prefers small groups.',
                voiceStyle: 'Thoughtful, concise, and curious.',
              }),
            },
          },
        ],
      });
    }
  );

  assert.deepEqual(draft, {
    displayName: 'Deepanshu',
    summary: 'A curious software builder.',
    interests: ['software', 'hackathons'],
    values: ['curiosity'],
    socialStyle: 'Prefers small groups.',
    voiceStyle: 'Thoughtful, concise, and curious.',
    speechSample: userAnswer,
  });
});

test('extractPersona rejects unusable input before calling the model', async () => {
  await assert.rejects(
    () => extractPersona('short', 'Deepanshu', 'test-key'),
    (error) =>
      error instanceof PersonaExtractionError &&
      error.status === 400
  );
});

test('extractPersona rejects malformed model output', async () => {
  await assert.rejects(
    () =>
      extractPersona(
        transcript,
        'Deepanshu',
        'test-key',
        async () =>
          Response.json({
            choices: [{ message: { content: 'not-json' } }],
          })
      ),
    (error) =>
      error instanceof PersonaExtractionError &&
      error.message === 'Model returned invalid persona JSON'
  );
});
