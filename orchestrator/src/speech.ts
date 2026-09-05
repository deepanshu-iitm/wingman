import type { FetchLike } from './openai.js';

const SMALLEST_TTS_ENDPOINT = 'https://api.smallest.ai/waves/v1/tts';
const MAX_SPEECH_BYTES = 5 * 1024 * 1024;

export type SynthesizedSpeech = {
  audioBase64: string;
  contentType: 'audio/wav';
};

export class SpeechSynthesisError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = 'SpeechSynthesisError';
  }
}

export async function synthesizeSpeech(
  text: string,
  apiKey: string,
  {
    voiceId = process.env.SMALLEST_TTS_VOICE ?? 'meher',
    language = 'en',
    fetchImpl = fetch,
  }: {
    voiceId?: string;
    language?: string;
    fetchImpl?: FetchLike;
  } = {},
): Promise<SynthesizedSpeech> {
  const safeText = text.trim().slice(0, 400);
  if (!safeText) {
    throw new SpeechSynthesisError('Speech text is required', 400);
  }

  const response = await fetchImpl(SMALLEST_TTS_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'audio/wav',
    },
    body: JSON.stringify({
      text: safeText,
      voice_id: voiceId,
      model: 'lightning_v3.1_pro',
      sample_rate: 24_000,
      speed: 1,
      language,
      output_format: 'wav',
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new SpeechSynthesisError(
      `Speech generation failed with status ${response.status}`,
      response.status,
    );
  }

  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.byteLength === 0 || audio.byteLength > MAX_SPEECH_BYTES) {
    throw new SpeechSynthesisError('Speech provider returned invalid audio');
  }

  return {
    audioBase64: audio.toString('base64'),
    contentType: 'audio/wav',
  };
}
