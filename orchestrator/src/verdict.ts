import type { ConversationMessage } from './agent.js';
import type { PersonaDraft } from './persona.js';

const CHAT_COMPLETIONS_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const maxHistoryMessages = 16;

type Fetch = typeof fetch;

export type CompatibilityVerdict = {
  score: number;
  rationale: string;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
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
  fetchImpl: Fetch = fetch
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

  const response = await fetchImpl(CHAT_COMPLETIONS_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? 'gpt-5-nano',
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
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'compatibility_verdict',
          strict: true,
          schema: verdictSchema,
        },
      },
      max_completion_tokens: 2_000,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new VerdictError(
      `Verdict generation failed with status ${response.status}`
    );
  }

  const payload = (await response.json()) as ChatCompletionResponse;
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    throw new VerdictError('Model returned no verdict');
  }

  let parsed: { score?: unknown; rationale?: unknown };
  try {
    parsed = JSON.parse(content) as {
      score?: unknown;
      rationale?: unknown;
    };
  } catch {
    throw new VerdictError('Model returned invalid verdict JSON');
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
