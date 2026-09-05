const STT_ENDPOINT = 'https://api.smallest.ai/waves/v1/stt/';

type Fetch = typeof fetch;

type TranscriptionResponse = {
  transcription?: unknown;
};

export class TranscriptionError extends Error {
  constructor(
    message: string,
    readonly status = 502
  ) {
    super(message);
    this.name = 'TranscriptionError';
  }
}

export async function transcribeAudio(
  audio: Uint8Array,
  apiKey: string,
  language = 'en',
  fetchImpl: Fetch = fetch
): Promise<string> {
  if (audio.byteLength === 0) {
    throw new TranscriptionError('Audio is empty', 400);
  }

  const url = new URL(STT_ENDPOINT);
  url.searchParams.set('model', 'pulse');
  url.searchParams.set('language', language);
  const body = new ArrayBuffer(audio.byteLength);
  new Uint8Array(body).set(audio);

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/octet-stream',
    },
    body,
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    throw new TranscriptionError(
      `Smallest.ai transcription failed with status ${response.status}`
    );
  }

  const payload = (await response.json()) as TranscriptionResponse;
  if (
    typeof payload.transcription !== 'string' ||
    payload.transcription.trim().length === 0
  ) {
    throw new TranscriptionError('Smallest.ai returned no transcript');
  }

  return payload.transcription.trim();
}
