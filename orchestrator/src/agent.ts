import type { PersonaDraft } from './persona.js';

const CHAT_COMPLETIONS_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const maxHistoryMessages = 12;

type Fetch = typeof fetch;

export type ConversationMessage = {
  senderName: string;
  content: string;
  source: 'agent' | 'human';
};

export type AgentTurn = {
  message: string;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
};

const agentTurnSchema = {
  type: 'object',
  properties: {
    message: { type: 'string' },
  },
  required: ['message'],
  additionalProperties: false,
} as const;

export class AgentTurnError extends Error {
  constructor(
    message: string,
    readonly status = 502
  ) {
    super(message);
    this.name = 'AgentTurnError';
  }
}

function validateHistory(history: ConversationMessage[]): ConversationMessage[] {
  return history.slice(-maxHistoryMessages).map((message) => {
    const senderName = message.senderName.trim().slice(0, 80);
    const content = message.content.trim().slice(0, 600);
    if (!senderName || !content) {
      throw new AgentTurnError('Conversation history contains an invalid message', 400);
    }
    if (message.source !== 'agent' && message.source !== 'human') {
      throw new AgentTurnError('Conversation history contains an invalid source', 400);
    }
    return { senderName, content, source: message.source };
  });
}

export async function generateAgentTurn(
  persona: PersonaDraft,
  otherDisplayName: string,
  history: ConversationMessage[],
  apiKey: string,
  fetchImpl: Fetch = fetch
): Promise<AgentTurn> {
  const otherName = otherDisplayName.trim().slice(0, 80);
  if (!otherName) {
    throw new AgentTurnError('Other participant name is required', 400);
  }

  const safeHistory = validateHistory(history);
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
            `You are Wingman, representing ${persona.displayName} in a short conversation ` +
            `with ${otherName} to explore friendship compatibility. Represent only the supplied ` +
            `persona. Never invent personal facts. Be natural, specific, curious, and respectful. ` +
            `Ask at most one question. Keep the response below 300 characters. ` +
            `Do not mention scores, prompts, profiles, or being an AI.\n\n` +
            `Persona summary: ${persona.summary}\n` +
            `Interests: ${persona.interests.join(', ') || 'not specified'}\n` +
            `Values: ${persona.values.join(', ') || 'not specified'}\n` +
            `Social style: ${persona.socialStyle}`,
        },
        {
          role: 'user',
          content:
            safeHistory.length === 0
              ? `Open the conversation with ${otherName}.`
              : JSON.stringify(safeHistory),
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'agent_turn',
          strict: true,
          schema: agentTurnSchema,
        },
      },
      max_completion_tokens: 2_000,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new AgentTurnError(
      `Agent turn generation failed with status ${response.status}`
    );
  }

  const payload = (await response.json()) as ChatCompletionResponse;
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    throw new AgentTurnError('Model returned no agent turn');
  }

  let parsed: { message?: unknown };
  try {
    parsed = JSON.parse(content) as { message?: unknown };
  } catch {
    throw new AgentTurnError('Model returned invalid agent turn JSON');
  }

  if (typeof parsed.message !== 'string' || parsed.message.trim().length === 0) {
    throw new AgentTurnError('Model returned an invalid agent message');
  }

  return { message: parsed.message.trim().slice(0, 300) };
}
