import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TranscriptionError,
  transcribeAudio,
} from '../dist/smallest.js';

test('transcribeAudio forwards audio securely and returns trimmed text', async () => {
  const audio = new Uint8Array([1, 2, 3]);

  const transcript = await transcribeAudio(
    audio,
    'test-key',
    'en',
    async (input, init) => {
      const url = new URL(input);
      assert.equal(url.origin + url.pathname, 'https://api.smallest.ai/waves/v1/stt/');
      assert.equal(url.searchParams.get('model'), 'pulse');
      assert.equal(url.searchParams.get('language'), 'en');
      assert.equal(init?.headers.Authorization, 'Bearer test-key');
      assert.equal(init?.headers['Content-Type'], 'application/octet-stream');
      assert.deepEqual(new Uint8Array(init?.body), audio);

      return Response.json({ transcription: '  Hello from Wingman.  ' });
    }
  );

  assert.equal(transcript, 'Hello from Wingman.');
});

test('transcribeAudio rejects empty audio before contacting the provider', async () => {
  await assert.rejects(
    () => transcribeAudio(new Uint8Array(), 'test-key'),
    (error) =>
      error instanceof TranscriptionError &&
      error.status === 400 &&
      error.message === 'Audio is empty'
  );
});

test('transcribeAudio hides provider response details', async () => {
  await assert.rejects(
    () =>
      transcribeAudio(
        new Uint8Array([1]),
        'test-key',
        'en',
        async () => new Response('sensitive upstream response', { status: 401 })
      ),
    (error) =>
      error instanceof TranscriptionError &&
      error.status === 502 &&
      error.message === 'Smallest.ai transcription failed with status 401'
  );
});
