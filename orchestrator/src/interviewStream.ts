import type { Server } from 'node:http';
import WebSocket, {
  WebSocketServer,
  type RawData,
} from 'ws';

import {
  fallbackInterviewStep,
  generateInterviewStep,
  MAX_INTERVIEW_ANSWERS,
  type InterviewDimension,
  type InterviewTurn,
} from './interview.js';
import { extractPersona } from './persona.js';
import { synthesizeSpeech } from './speech.js';

const DEFAULT_SMALLEST_STREAM_URL =
  'wss://api.smallest.ai/waves/v1/pulse/get_text';
const MAX_QUEUED_AUDIO_BYTES = 1024 * 1024;
const MAX_AUDIO_FRAME_BYTES = 64 * 1024;
const OPENING_QUESTION =
  'Tell me about a friendship that feels easy and natural to you. What makes it work?';

type SmallestEvent = {
  type?: unknown;
  transcript?: unknown;
  full_transcript?: unknown;
  is_final?: unknown;
};

type JsonMessage = Record<string, unknown>;

function sendJson(socket: WebSocket, message: JsonMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function transcriptForPersona(turns: InterviewTurn[]): string {
  return turns
    .map((turn) => `${turn.role === 'assistant' ? 'Wingman' : 'User'}: ${turn.content}`)
    .join('\n');
}

export function attachInterviewStream(
  server: Server,
  {
    clientOrigin,
    smallestApiKey = process.env.SMALLEST_API_KEY,
    openAiApiKey = process.env.OPENAI_API_KEY,
  }: {
    clientOrigin: string;
    smallestApiKey?: string;
    openAiApiKey?: string;
  },
): void {
  const webSocketServer = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const requestUrl = new URL(
      request.url ?? '/',
      `http://${request.headers.host ?? 'localhost'}`,
    );
    if (requestUrl.pathname !== '/api/interview/stream') return;

    const origin = request.headers.origin;
    if (origin && origin !== clientOrigin) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!smallestApiKey || !openAiApiKey) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      webSocketServer.emit('connection', client, request);
    });
  });

  webSocketServer.on(
    'connection',
    (client: WebSocket, request) => {
      const requestUrl = new URL(
        request.url ?? '/',
        `http://${request.headers.host ?? 'localhost'}`,
      );
      const displayName = (requestUrl.searchParams.get('displayName') ?? '')
        .trim()
        .slice(0, 80);
      const language = requestUrl.searchParams.get('language') ?? 'en';
      if (!displayName || !/^[a-z]{2}(?:-[a-z]+)?$/i.test(language)) {
        sendJson(client, {
          type: 'error',
          error: 'A valid display name and language are required',
        });
        client.close(1008, 'Invalid interview parameters');
        return;
      }

      const smallestUrl = new URL(
        process.env.SMALLEST_STREAMING_URL ?? DEFAULT_SMALLEST_STREAM_URL,
      );
      smallestUrl.searchParams.set('language', language);
      smallestUrl.searchParams.set('encoding', 'linear16');
      smallestUrl.searchParams.set('sample_rate', '16000');
      smallestUrl.searchParams.set('endpointing', 'true');
      smallestUrl.searchParams.set('eou_timeout_ms', '3000');
      smallestUrl.searchParams.set('vad_events', 'true');
      smallestUrl.searchParams.set('full_transcript', 'true');

      const upstream = new WebSocket(smallestUrl, {
        headers: { Authorization: `Bearer ${smallestApiKey as string}` },
      });
      const queuedAudio: Buffer[] = [];
      let queuedBytes = 0;
      let processingFinal = false;
      let completed = false;
      let finishRequested = false;
      let finishTimer: ReturnType<typeof setTimeout> | undefined;
      let acceptingAnswer = false;
      let acceptingAnswerSince = 0;
      let lastFinal = '';
      let coveredDimensions: InterviewDimension[] = [];
      const turns: InterviewTurn[] = [
        { role: 'assistant', content: OPENING_QUESTION },
      ];

      const sendSpokenText = async (
        text: string,
        purpose: 'question' | 'reply',
      ): Promise<void> => {
        sendJson(client, { type: 'status', state: 'generating_speech' });
        try {
          const speech = await synthesizeSpeech(
            text,
            smallestApiKey as string,
            { language: language.split('-')[0] ?? 'en' },
          );
          sendJson(client, {
            type: 'speech',
            purpose,
            text,
            ...speech,
          });
        } catch (error) {
          console.warn('Interview speech generation failed.', error);
          sendJson(client, {
            type: 'speech.unavailable',
            purpose,
            text,
          });
        }
      };

      const finishInterview = async (): Promise<void> => {
        if (completed) return;
        completed = true;
        sendJson(client, { type: 'status', state: 'creating_persona' });
        try {
          const persona = await extractPersona(
            transcriptForPersona(turns),
            displayName,
            openAiApiKey as string,
          );
          sendJson(client, { type: 'persona', persona });
          if (upstream.readyState === WebSocket.OPEN) {
            upstream.send(JSON.stringify({ type: 'finalize' }));
          }
        } catch (error) {
          completed = false;
          sendJson(client, {
            type: 'error',
            error:
              error instanceof Error
                ? error.message
                : 'Persona extraction failed',
          });
        }
      };

      const handleFinalTranscript = async (transcript: string): Promise<void> => {
        const answer = transcript.trim();
        if (
          !answer ||
          answer === lastFinal ||
          processingFinal ||
          completed ||
          !acceptingAnswer ||
          Date.now() - acceptingAnswerSince < 350
        ) {
          return;
        }
        acceptingAnswer = false;
        lastFinal = answer;
        clearTimeout(finishTimer);
        processingFinal = true;
        turns.push({ role: 'user', content: answer });
        sendJson(client, { type: 'transcript.final', text: answer });
        sendJson(client, { type: 'status', state: 'thinking' });

        const answerCount = turns.filter((turn) => turn.role === 'user').length;
        if (finishRequested || answerCount >= MAX_INTERVIEW_ANSWERS) {
          const closingReply =
            'Thanks — I have enough to build your friendship profile now.';
          turns.push({ role: 'assistant', content: closingReply });
          sendJson(client, { type: 'reply', text: closingReply });
          await sendSpokenText(closingReply, 'reply');
          processingFinal = false;
          await finishInterview();
          return;
        }

        let step;
        try {
          step = await generateInterviewStep(
            turns,
            coveredDimensions,
            openAiApiKey as string,
          );
        } catch (error) {
          console.warn('Adaptive interview generation failed; using fallback.', error);
          step = fallbackInterviewStep(coveredDimensions);
        }
        coveredDimensions = [
          ...new Set([...coveredDimensions, ...step.coveredDimensions]),
        ];
        turns.push({
          role: 'assistant',
          content: `${step.reply} ${step.question}`,
        });
        processingFinal = false;

        if (step.readyToFinalize) {
          sendJson(client, { type: 'reply', text: step.reply });
          await sendSpokenText(step.reply, 'reply');
          await finishInterview();
          return;
        }
        sendJson(client, {
          type: 'question',
          reply: step.reply,
          question: step.question,
          answerNumber: answerCount + 1,
          maximumAnswers: MAX_INTERVIEW_ANSWERS,
        });
        await sendSpokenText(
          `${step.reply} ${step.question}`,
          'question',
        );
        sendJson(client, { type: 'status', state: 'awaiting_answer' });
      };

      upstream.on('open', () => {
        for (const chunk of queuedAudio) upstream.send(chunk);
        queuedAudio.length = 0;
        queuedBytes = 0;
        sendJson(client, {
          type: 'ready',
          question: OPENING_QUESTION,
          maximumAnswers: MAX_INTERVIEW_ANSWERS,
          audio: { encoding: 'linear16', sampleRate: 16000 },
        });
        void sendSpokenText(OPENING_QUESTION, 'question').then(() => {
          sendJson(client, { type: 'status', state: 'awaiting_answer' });
        });
      });

      upstream.on('message', (data) => {
        let event: SmallestEvent;
        try {
          event = JSON.parse(data.toString()) as SmallestEvent;
        } catch {
          return;
        }
        if (
          event.type === 'speech_started' ||
          event.type === 'speech_ended'
        ) {
          sendJson(client, { type: 'vad', event: event.type });
        }
        const transcript =
          typeof event.transcript === 'string' ? event.transcript : '';
        if (!transcript) return;
        if (event.is_final === true) {
          void handleFinalTranscript(transcript);
        } else if (!processingFinal && !completed) {
          sendJson(client, { type: 'transcript.partial', text: transcript });
        }
      });

      upstream.on('error', (error) => {
        console.error('Smallest streaming error', error);
        sendJson(client, {
          type: 'error',
          error: 'Live transcription is temporarily unavailable',
        });
      });
      upstream.on('close', () => {
        if (!completed) {
          sendJson(client, {
            type: 'error',
            error: 'Live transcription connection closed',
          });
        }
      });

      client.on('message', (data: RawData, isBinary: boolean) => {
        if (completed || processingFinal) return;
        if (!isBinary) {
          try {
            const message = JSON.parse(data.toString()) as { type?: unknown };
            if (
              message.type === 'finalize' &&
              upstream.readyState === WebSocket.OPEN
            ) {
              upstream.send(JSON.stringify({ type: 'finalize' }));
            } else if (message.type === 'ready_for_answer') {
              acceptingAnswer = true;
              acceptingAnswerSince = Date.now();
              sendJson(client, { type: 'status', state: 'listening' });
            } else if (
              message.type === 'finish' &&
              upstream.readyState === WebSocket.OPEN
            ) {
              finishRequested = true;
              upstream.send(JSON.stringify({ type: 'finalize' }));
              finishTimer = setTimeout(() => {
                if (processingFinal || completed) return;
                const answerCount = turns.filter(
                  (turn) => turn.role === 'user',
                ).length;
                if (answerCount > 0) {
                  void finishInterview();
                } else {
                  finishRequested = false;
                  sendJson(client, {
                    type: 'finish.rejected',
                    error: 'Answer at least one question before finishing.',
                  });
                }
              }, 2_500);
            }
          } catch {
            sendJson(client, { type: 'error', error: 'Invalid control message' });
          }
          return;
        }

        const chunk = Buffer.isBuffer(data)
          ? data
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : Buffer.concat(data);
        if (chunk.byteLength > MAX_AUDIO_FRAME_BYTES) {
          sendJson(client, { type: 'error', error: 'Audio frame is too large' });
          return;
        }
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(chunk);
        } else if (
          upstream.readyState === WebSocket.CONNECTING &&
          queuedBytes + chunk.byteLength <= MAX_QUEUED_AUDIO_BYTES
        ) {
          queuedAudio.push(chunk);
          queuedBytes += chunk.byteLength;
        }
      });

      client.on('close', () => {
        clearTimeout(finishTimer);
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(JSON.stringify({ type: 'finalize' }));
        }
        upstream.close();
      });
    },
  );
}
