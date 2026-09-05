import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import { TranscriptionError, transcribeAudio } from './smallest.js';

const port = Number(process.env.ORCHESTRATOR_PORT ?? 8787);
const clientOrigin = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';
const maxAudioBytes = 20 * 1024 * 1024;
const supportedAudioTypes = new Set([
  'application/octet-stream',
  'audio/flac',
  'audio/m4a',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/x-m4a',
  'audio/x-wav',
]);

class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>
): void {
  response.writeHead(status, {
    'Access-Control-Allow-Origin': clientOrigin,
    'Content-Type': 'application/json; charset=utf-8',
    Vary: 'Origin',
  });
  response.end(JSON.stringify(body));
}

async function readAudio(request: IncomingMessage): Promise<Uint8Array> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim();
  if (!contentType || !supportedAudioTypes.has(contentType)) {
    throw new RequestError('Unsupported audio content type', 415);
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxAudioBytes) {
      throw new RequestError('Audio exceeds the 20 MB limit', 413);
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Origin': clientOrigin,
      Vary: 'Origin',
    });
    response.end();
    return;
  }

  const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (request.method === 'GET' && requestUrl.pathname === '/health') {
    sendJson(response, 200, { status: 'ok', service: 'wingman-orchestrator' });
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/transcribe') {
    const apiKey = process.env.SMALLEST_API_KEY;
    if (!apiKey) {
      sendJson(response, 503, { error: 'Voice transcription is not configured' });
      return;
    }

    const language = requestUrl.searchParams.get('language') ?? 'en';
    if (!/^[a-z]{2}(?:-[a-z]+)?$/i.test(language)) {
      sendJson(response, 400, { error: 'Invalid language code' });
      return;
    }

    try {
      const audio = await readAudio(request);
      const transcript = await transcribeAudio(audio, apiKey, language);
      sendJson(response, 200, { transcript });
    } catch (error) {
      if (error instanceof RequestError || error instanceof TranscriptionError) {
        sendJson(response, error.status, { error: error.message });
        return;
      }

      console.error('Unexpected transcription error', error);
      sendJson(response, 500, { error: 'Unexpected transcription error' });
    }
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
});

server.listen(port, () => {
  console.log(`Wingman orchestrator listening on http://localhost:${port}`);
});
