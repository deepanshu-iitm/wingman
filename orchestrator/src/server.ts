import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { attachInterviewStream } from './interviewStream.js';
import { extractPersona, PersonaExtractionError } from './persona.js';
import { TranscriptionError, transcribeAudio } from './smallest.js';
import {
  sendWelcomeEmail,
  validateEmail,
  WelcomeEmailError,
} from './welcome.js';

// Managed hosts (Render, Railway, Fly, …) inject the bound port via PORT.
const port = Number(process.env.PORT ?? process.env.ORCHESTRATOR_PORT ?? 8787);
const clientOrigin = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';
const maxAudioBytes = 20 * 1024 * 1024;
const welcomedEmails = new Set<string>();
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

async function sendDemo(response: ServerResponse): Promise<void> {
  try {
    const html = await readFile(new URL('../demo/index.html', import.meta.url));
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
    });
    response.end(html);
  } catch {
    sendJson(response, 500, { error: 'Voice demo is unavailable' });
  }
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

async function readJson(
  request: IncomingMessage
): Promise<Record<string, unknown>> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim();
  if (contentType !== 'application/json') {
    throw new RequestError('Content type must be application/json', 415);
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > 16 * 1024) {
      throw new RequestError('Request exceeds the 16 KB limit', 413);
    }
    chunks.push(buffer);
  }

  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error();
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new RequestError('Request body must be valid JSON', 400);
  }
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

  if (request.method === 'GET' && requestUrl.pathname === '/demo') {
    await sendDemo(response);
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

  if (request.method === 'POST' && requestUrl.pathname === '/api/persona') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      sendJson(response, 503, { error: 'Persona extraction is not configured' });
      return;
    }

    try {
      const body = await readJson(request);
      const transcript =
        typeof body.transcript === 'string' ? body.transcript : '';
      const displayName =
        typeof body.displayName === 'string' ? body.displayName : '';
      const persona = await extractPersona(
        transcript,
        displayName,
        apiKey
      );
      sendJson(response, 200, { persona });
    } catch (error) {
      if (error instanceof RequestError || error instanceof PersonaExtractionError) {
        sendJson(response, error.status, { error: error.message });
        return;
      }

      console.error('Unexpected persona extraction error', error);
      sendJson(response, 500, { error: 'Unexpected persona extraction error' });
    }
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/welcome') {
    const apiKey = process.env.BREVO_API_KEY;
    const from = process.env.WELCOME_EMAIL_FROM;
    if (!apiKey || !from) {
      sendJson(response, 503, { error: 'Welcome email is not configured' });
      return;
    }

    try {
      const body = await readJson(request);
      const email = validateEmail(body.email);
      const displayName =
        typeof body.displayName === 'string' ? body.displayName : '';

      if (!welcomedEmails.has(email)) {
        await sendWelcomeEmail(email, displayName, apiKey, from);
        welcomedEmails.add(email);
      }
      sendJson(response, 202, { status: 'accepted' });
    } catch (error) {
      if (error instanceof RequestError || error instanceof WelcomeEmailError) {
        sendJson(response, error.status, { error: error.message });
        return;
      }

      console.error('Unexpected welcome email error', error);
      sendJson(response, 500, { error: 'Unexpected welcome email error' });
    }
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
});

attachInterviewStream(server, { clientOrigin });

server.listen(port, () => {
  console.log(`Wingman orchestrator listening on http://localhost:${port}`);

  if (process.env.RUN_MATCHING_WORKER === 'true') {
    const matchingDirectory = fileURLToPath(new URL('../matching/', import.meta.url));
    const worker = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/index.ts'],
      {
        cwd: matchingDirectory,
        env: process.env,
        stdio: 'inherit',
      }
    );

    worker.on('exit', (code, signal) => {
      console.error(
        `Matching worker exited (${signal ?? `code ${code ?? 1}`}); restarting the service.`
      );
      process.exit(code ?? 1);
    });
  }
});
