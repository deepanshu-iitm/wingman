import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AgentTurnError,
  generateAgentTurn,
} from '../dist/agent.js';

const persona = {
  displayName: 'Deepanshu',
  summary: 'A curious builder who enjoys thoughtful conversations.',
  interests: ['software', 'music'],
  values: ['curiosity', 'kindness'],
  socialStyle: 'Prefers small groups.',
};

test('generateAgentTurn returns a bounded validated message', async () => {
  const result = await generateAgentTurn(
    persona,
    'Ramesh',
    [
      {
        senderName: 'Ramesh',
        content: 'What do you enjoy building?',
        source: 'agent',
      },
    ],
    'test-key',
    async (_input, init) => {
      const request = JSON.parse(init?.body);
      assert.equal(request.model, 'gpt-5.6-luna');
      assert.equal(request.response_format.type, 'json_schema');
      assert.equal(request.max_completion_tokens, 4_000);
      assert.equal(init?.headers.Authorization, 'Bearer test-key');

      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                message:
                  'Deepanshu loves building tools that bring people together. What kind of problems keep you curious?',
              }),
            },
          },
        ],
      });
    }
  );

  assert.equal(
    result.message,
    'Deepanshu loves building tools that bring people together. What kind of problems keep you curious?'
  );
});

test('generateAgentTurn limits history sent to the model', async () => {
  const history = Array.from({ length: 20 }, (_, index) => ({
    senderName: 'Ramesh',
    content: `Message ${index}`,
    source: 'agent',
  }));

  await generateAgentTurn(
    persona,
    'Ramesh',
    history,
    'test-key',
    async (_input, init) => {
      const request = JSON.parse(init?.body);
      const sentHistory = JSON.parse(request.messages[1].content);
      assert.equal(sentHistory.length, 12);
      assert.equal(sentHistory[0].content, 'Message 8');

      return Response.json({
        choices: [{ message: { content: '{"message":"Hello!"}' } }],
      });
    }
  );
});

test('generateAgentTurn rejects an empty participant name', async () => {
  await assert.rejects(
    () => generateAgentTurn(persona, ' ', [], 'test-key'),
    (error) => error instanceof AgentTurnError && error.status === 400
  );
});
