import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fallbackInterviewStep,
  generateInterviewStep,
  InterviewGenerationError,
} from '../dist/interview.js';

test('generateInterviewStep asks a bounded adaptive follow-up', async () => {
  const result = await generateInterviewStep(
    [
      {
        role: 'assistant',
        content: 'What makes a friendship feel easy to you?',
      },
      {
        role: 'user',
        content: 'I like friends who are spontaneous and communicate directly.',
      },
    ],
    [],
    'test-key',
    async (_input, init) => {
      const request = JSON.parse(init?.body);
      const context = JSON.parse(request.messages[1].content);
      assert.equal(request.model, 'gpt-5.6-luna');
      assert.equal(request.response_format.type, 'json_schema');
      assert.equal(request.max_completion_tokens, 4_000);
      assert.equal(context.answerCount, 1);

      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                reply: 'Spontaneity and honesty sound important to you.',
                question: 'After a busy week, how do you most enjoy recharging?',
                coveredDimensions: [
                  'planning_style',
                  'communication_style',
                  'social_energy',
                ],
                readyToFinalize: true,
              }),
            },
          },
        ],
      });
    },
  );

  assert.equal(result.readyToFinalize, false);
  assert.deepEqual(result.coveredDimensions, [
    'planning_style',
    'communication_style',
    'social_energy',
  ]);
});

test('generateInterviewStep rejects a conversation without a user answer', async () => {
  await assert.rejects(
    () =>
      generateInterviewStep(
        [{ role: 'assistant', content: 'Tell me about yourself.' }],
        [],
        'test-key',
      ),
    (error) =>
      error instanceof InterviewGenerationError && error.status === 400,
  );
});

test('fallbackInterviewStep advances to the next uncovered dimension', () => {
  const result = fallbackInterviewStep(['social_energy', 'openness']);

  assert.match(result.question, /plan|moment/i);
  assert.deepEqual(result.coveredDimensions, [
    'social_energy',
    'openness',
    'planning_style',
  ]);
  assert.equal(result.readyToFinalize, false);
});
