import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SpeechSynthesisError,
  synthesizeSpeech,
} from '../dist/speech.js';

test('synthesizeSpeech returns browser-playable audio without exposing the key', async () => {
  const audio = Buffer.from('test-wave-audio');
  const result = await synthesizeSpeech(
    'What matters most in a friendship?',
    'test-key',
    {
      voiceId: 'meher',
      fetchImpl: async (_input, init) => {
        assert.equal(init?.headers.Authorization, 'Bearer test-key');
        assert.equal(init?.headers.Accept, 'audio/wav');
        const body = JSON.parse(init?.body);
        assert.deepEqual(body, {
          text: 'What matters most in a friendship?',
          voice_id: 'meher',
          model: 'lightning_v3.1_pro',
          sample_rate: 24_000,
          speed: 1,
          language: 'en',
          output_format: 'wav',
        });
        return new Response(audio);
      },
    },
  );

  assert.deepEqual(result, {
    audioBase64: audio.toString('base64'),
    contentType: 'audio/wav',
  });
});

test('synthesizeSpeech rejects empty text before contacting the provider', async () => {
  await assert.rejects(
    () => synthesizeSpeech(' ', 'test-key'),
    (error) =>
      error instanceof SpeechSynthesisError && error.status === 400,
  );
});
