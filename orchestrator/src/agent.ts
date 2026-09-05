import type { PersonaDraft } from './persona.js';
import {
  requestStructuredJson,
  StructuredCompletionError,
  type FetchLike,
} from './openai.js';

const maxHistoryMessages = 12;

export type ConversationMessage = {
  senderName: string;
  content: string;
  source: 'agent' | 'human';
};

export type AgentTurn = {
  message: string;
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
  fetchImpl: FetchLike = fetch
): Promise<AgentTurn> {
  const otherName = otherDisplayName.trim().slice(0, 80);
  if (!otherName) {
    throw new AgentTurnError('Other participant name is required', 400);
  }

  const safeHistory = validateHistory(history);
  let parsed: { message?: unknown };
  try {
    parsed = await requestStructuredJson<{ message?: unknown }>({
      apiKey,
      schemaName: 'agent_turn',
      schema: agentTurnSchema,
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
      fetchImpl,
    });
  } catch (error) {
    if (error instanceof StructuredCompletionError) {
      throw new AgentTurnError(error.message, error.status);
    }
    throw error;
  }

  if (typeof parsed.message !== 'string' || parsed.message.trim().length === 0) {
    throw new AgentTurnError('Model returned an invalid agent message');
  }

  return { message: parsed.message.trim().slice(0, 300) };
}
