import type { ConversationMessage } from './agent.js';
import {
  requestStructuredJson,
  StructuredCompletionError,
  type FetchLike,
} from './openai.js';
import type { PersonaDraft } from './persona.js';

const maxHistoryMessages = 16;

export type CompatibilityVerdict = {
  score: number;
  rationale: string;
};

const verdictSchema = {
  type: 'object',
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 100 },
    rationale: { type: 'string' },
  },
  required: ['score', 'rationale'],
  additionalProperties: false,
} as const;

export class VerdictError extends Error {
  constructor(
    message: string,
    readonly status = 502
  ) {
    super(message);
    this.name = 'VerdictError';
  }
}

export async function generateVerdict(
  firstPersona: PersonaDraft,
  secondPersona: PersonaDraft,
  history: ConversationMessage[],
  apiKey: string,
  fetchImpl: FetchLike = fetch
): Promise<CompatibilityVerdict> {
  if (history.length === 0) {
    throw new VerdictError('A conversation is required for a verdict', 400);
  }

  const safeHistory = history.slice(-maxHistoryMessages).map((message) => ({
    senderName: message.senderName.trim().slice(0, 80),
    content: message.content.trim().slice(0, 600),
    source: message.source,
  }));

  if (safeHistory.some((message) => !message.senderName || !message.content)) {
    throw new VerdictError('Conversation contains an invalid message', 400);
  }

  let parsed: { score?: unknown; rationale?: unknown };
  try {
    parsed = await requestStructuredJson<{
      score?: unknown;
      rationale?: unknown;
    }>({
      apiKey,
      schemaName: 'compatibility_verdict',
      schema: verdictSchema,
      messages: [
        {
          role: 'system',
          content:
            'Assess potential friendship compatibility using only the supplied persona summaries ' +
            'and conversation. Return an integer score from 0 to 100 and a concise, specific ' +
            'rationale under 300 characters. This is a lightweight social recommendation, not a ' +
            'scientific or clinical assessment. Do not infer sensitive traits.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            firstPersona,
            secondPersona,
            conversation: safeHistory,
          }),
        },
      ],
      fetchImpl,
    });
  } catch (error) {
    if (error instanceof StructuredCompletionError) {
      throw new VerdictError(error.message, error.status);
    }
    throw error;
  }

  if (
    typeof parsed.score !== 'number' ||
    !Number.isInteger(parsed.score) ||
    parsed.score < 0 ||
    parsed.score > 100
  ) {
    throw new VerdictError('Model returned an invalid compatibility score');
  }
  if (
    typeof parsed.rationale !== 'string' ||
    parsed.rationale.trim().length === 0
  ) {
    throw new VerdictError('Model returned an invalid rationale');
  }

  return {
    score: parsed.score,
    rationale: parsed.rationale.trim().slice(0, 300),
  };
}
