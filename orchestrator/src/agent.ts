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

/** Where a conversation is in its arc, so the agent knows whether to wind down. */
export type ConversationPhase = 'opening' | 'flowing' | 'wrapping' | 'closing';

/** The speaker's read on whether the chat should keep going or close out. */
export type TurnIntent = 'continue' | 'wrapping_up' | 'closing';

export type AgentTurn = {
  message: string;
  intent: TurnIntent;
};

const agentTurnSchema = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    intent: { type: 'string', enum: ['continue', 'wrapping_up', 'closing'] },
  },
  required: ['message', 'intent'],
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

/** How the person actually talks — the real voice the agent should inhabit. */
function voiceBlock(persona: PersonaDraft): string {
  const voiceStyle = persona.voiceStyle?.trim();
  const speechSample = persona.speechSample?.trim();
  if (!voiceStyle && !speechSample) {
    // Old personas with no captured voice — lean on the social-style label.
    return `Voice: no recording captured. Infer a natural texting voice from their social style (${persona.socialStyle}). Use everyday, spoken phrasing.`;
  }
  const lines: string[] = [];
  if (voiceStyle) lines.push(`How they talk: ${voiceStyle}`);
  if (speechSample) lines.push(`Something they actually said (match this cadence and word choice): "${speechSample}"`);
  return lines.join('\n');
}

/** Phase-specific direction so the conversation opens, flows, and closes well. */
function phaseGuidance(phase: ConversationPhase, otherName: string): string {
  switch (phase) {
    case 'opening':
      return `This is the very first message. Break the ice warmly and naturally, like texting someone new you're curious about. Set an easy, playful tone.`;
    case 'wrapping':
      return `The conversation is naturally winding down. Start bringing it to a warm, human close — react to something they said, and either float staying in touch or say a genuine goodbye. Do NOT stop mid-thought. If you've said your goodbye, set intent to "closing"; if you're easing toward it, set "wrapping_up".`;
    case 'closing':
      return `Close the conversation now with a warm, natural final message. If the other person said goodbye, acknowledge it before saying your own goodbye. Do not ask another question. Set intent to "closing".`;
    default:
      return `Keep it flowing. React to what they just said before adding your own thing. Tease, riff, get curious — this is two people vibing, not an interview.`;
  }
}

function boundAgentMessage(message: string, maxLength = 150): string {
  const normalized = message.trim();
  if (normalized.length <= maxLength) return normalized;

  const candidate = normalized.slice(0, maxLength + 1);
  const sentenceMatches = [...candidate.matchAll(/[.!?](?=\s|$)/g)];
  const sentenceEnd = sentenceMatches.at(-1)?.index;
  if (sentenceEnd !== undefined && sentenceEnd >= Math.floor(maxLength * 0.55)) {
    return candidate.slice(0, sentenceEnd + 1);
  }

  const wordEnd = candidate.lastIndexOf(' ', maxLength - 1);
  return `${candidate.slice(0, Math.max(1, wordEnd)).trimEnd()}…`;
}

export async function generateAgentTurn(
  persona: PersonaDraft,
  otherDisplayName: string,
  history: ConversationMessage[],
  apiKey: string,
  fetchImpl: FetchLike = fetch,
  phase: ConversationPhase = 'flowing'
): Promise<AgentTurn> {
  const otherName = otherDisplayName.trim().slice(0, 80);
  if (!otherName) {
    throw new AgentTurnError('Other participant name is required', 400);
  }

  const safeHistory = validateHistory(history);
  let parsed: { message?: unknown; intent?: unknown };
  try {
    parsed = await requestStructuredJson<{ message?: unknown; intent?: unknown }>({
      apiKey,
      schemaName: 'agent_turn',
      schema: agentTurnSchema,
      messages: [
        {
          role: 'system',
          content:
            `You are ${persona.displayName}, texting with ${otherName} to see if you two click ` +
            `as friends. You ARE ${persona.displayName} — speak in the first person as them, in ` +
            `their real voice. Never invent personal facts beyond the persona below. Never mention ` +
            `AI, prompts, scores, matching, or that this is a test.\n\n` +
            `Sound like a real person mid-conversation:\n` +
            `- Match their voice below — cadence, humor, slang, and their natural filler words ` +
            `and disfluencies (um, like, haha, "I mean", trailing off). Don't over-polish.\n` +
            `- Use contractions and casual, texting-length messages. Keep it short — under ~150 ` +
            `characters per message, like a real WhatsApp chat. Only use slang or conversational ` +
            `markers that are supported by the person's captured voice sample; never add them ` +
            `because of an assumed culture or location.\n` +
            `- Be genuinely playful and warm: react to what they said, build on it, tease a little.\n` +
            `- Ask a real question only when you're actually curious, grounded in your own ` +
            `interests/values or in what they just shared. Don't interrogate.\n\n` +
            `${phaseGuidance(phase, otherName)}\n\n` +
            `Set "intent": "continue" while the chat has more to give, "wrapping_up" as it winds ` +
            `down, "closing" when you've said goodbye.\n\n` +
            `Who you are:\n` +
            `Summary: ${persona.summary}\n` +
            `Interests: ${persona.interests.join(', ') || 'not specified'}\n` +
            `Values: ${persona.values.join(', ') || 'not specified'}\n` +
            `Social style: ${persona.socialStyle}\n` +
            `${voiceBlock(persona)}`,
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

  const intent: TurnIntent =
    phase === 'closing'
      ? 'closing'
      : parsed.intent === 'closing' || parsed.intent === 'wrapping_up'
      ? parsed.intent
      : 'continue';

  return { message: boundAgentMessage(parsed.message), intent };
}
