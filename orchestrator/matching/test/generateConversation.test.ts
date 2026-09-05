import assert from 'node:assert/strict';
import test from 'node:test';

import {
  generateAgentTurn,
  scoreConversation,
  type PersonaLike,
  type Turn,
} from '../src/generateConversation.js';

const alex: PersonaLike = {
  id: 1n,
  displayName: 'Alex',
  summary: 'Curious builder',
  interests: ['music', 'hiking'],
  values: ['kindness'],
  socialStyle: 'warm',
  voiceStyle: 'casual and upbeat, laughs a lot',
  speechSample: "Oh man, I've just been super into building stuff lately, you know?",
};

const sam: PersonaLike = {
  id: 2n,
  displayName: 'Sam',
  summary: 'Creative explorer',
  interests: ['music'],
  values: ['kindness'],
  socialStyle: 'warm',
  voiceStyle: 'thoughtful, a little dry',
  speechSample: 'I mean, music is kind of my whole thing, honestly.',
};

test('generateAgentTurn returns exactly the requested speaker', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const turn = await generateAgentTurn(alex, sam, []);
    assert.equal(turn.senderPersonaId, alex.id);
    assert.equal(turn.senderName, alex.displayName);
    assert.ok(turn.content.length > 0);
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('placeholder verdict incorporates completed conversation evidence', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const empty = await scoreConversation(alex, sam, []);
    const history: Turn[] = [
      { senderPersonaId: alex.id, senderName: alex.displayName, content: 'I love live music.', source: 'agent', intent: 'continue' },
      { senderPersonaId: sam.id, senderName: sam.displayName, content: 'Me too.', source: 'agent', intent: 'continue' },
    ];
    const conversational = await scoreConversation(alex, sam, history);
    assert.ok(conversational.rawScore > empty.rawScore);
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('LLM verdict receives the transcript and validates structured output', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  try {
    const history: Turn[] = [
      { senderPersonaId: alex.id, senderName: alex.displayName, content: 'Hello Sam', source: 'agent', intent: 'continue' },
    ];
    const result = await scoreConversation(alex, sam, history, async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: string }>;
      };
      assert.match(request.messages[1].content, /Hello Sam/);
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"score":82,"rationale":"Shared curiosity."}' } }],
      }));
    });
    assert.deepEqual(result, {
      rawScore: 82,
      signalStrength: 82,
      reason: 'Shared curiosity.',
      model: process.env.OPENAI_MODEL ?? 'gpt-5.6-luna',
    });
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('agent generation falls back when OpenAI is temporarily unavailable', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  try {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const turn = await generateAgentTurn(
        alex,
        sam,
        [],
        'flowing',
        async () => new Response('busy', { status: 503 }),
      );
      assert.equal(turn.senderPersonaId, alex.id);
      assert.ok(turn.content.length > 0);
    } finally {
      console.warn = originalWarn;
    }
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});
