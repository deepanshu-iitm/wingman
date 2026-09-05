/**
 * The ONLY LLM-touching seam in the whole system.
 *
 * Two exported functions form the seam:
 *   • `generateAgentTurn(speaker, counterpart, history)` — produces the NEXT
 *     single turn given the conversation so far. The orchestrator calls this one
 *     turn at a time and appends the result to the DB between calls, so later
 *     turns can react to what has actually been written (including a human
 *     takeover). This is agents acting through shared state, not scripted
 *     playback.
 *   • `scoreConversation(a, b, history)` — judges the completed conversation
 *     for ranking + training. Kept internal; never shown as a "% match".
 *
 * Both ship in deterministic **placeholder mode** (canned, persona-flavored
 * dialogue + an overlap heuristic) so the whole Match-Me flow works with no API
 * key. To go live, swap the placeholder bodies for OpenAI calls — the return
 * shapes stay identical, so nothing else in the orchestrator, module, or client
 * changes. That LLM work is Deepanshu's domain (see the team plan).
 */

import { CONFIG } from './config.js';

/** Minimal persona shape the generator needs (subset of the `persona` row). */
export interface PersonaLike {
  id: bigint;
  displayName: string;
  summary: string;
  interests: string[];
  values: string[];
  socialStyle: string;
}

export interface Turn {
  senderPersonaId: bigint;
  senderName: string;
  content: string;
}

export interface ConversationScore {
  /** Honest 0–100 compatibility signal (stored for training + ranking). */
  rawScore: number;
  /** Final 0–100 "signals" strength the UI ramps toward. */
  signalStrength: number;
  /** Short human-readable reason for the ranking. */
  reason: string;
  /** Which generator produced this ('placeholder' | 'gpt-4o-mini' | …). */
  model: string;
}

type Fetch = typeof fetch;

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: unknown } }>;
};

const SCORE_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

// ── Public seam: one turn at a time ──────────────────────────────────────────

/**
 * Generate the next turn spoken by `speaker` (replying to `counterpart`), given
 * the turns that already exist. The orchestrator appends each returned turn to
 * the DB before requesting the next, so generation always sees current state.
 *
 * LLM drop-in (Deepanshu): call the model here with `history` as context and
 * return `{ senderPersonaId: speaker.id, senderName: speaker.displayName,
 * content }`. Keep it bounded to a single turn.
 */
export async function generateAgentTurn(
  speaker: PersonaLike,
  counterpart: PersonaLike,
  history: Turn[],
): Promise<Turn> {
  const content = placeholderTurn(speaker, counterpart, history.length);
  return {
    senderPersonaId: speaker.id,
    senderName: speaker.displayName,
    content,
  };
}

/** How many agent turns a placeholder conversation should run to. */
export function plannedTurnCount(): number {
  return Math.max(2, CONFIG.TURNS_PER_CONVO);
}

// ── Public seam: score / rank ────────────────────────────────────────────────

/**
 * Deterministic compatibility judgement for ranking + training. LLM drop-in:
 * replace with a single "judge" call over the finished transcript.
 */
export async function scoreConversation(
  a: PersonaLike,
  b: PersonaLike,
  history: Turn[],
  fetchImpl: Fetch = fetch,
): Promise<ConversationScore> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    const response = await fetchImpl(SCORE_ENDPOINT, {
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
              'Assess friendship compatibility using only the supplied personas and completed conversation. ' +
              'Return a 0-100 integer score and a concise rationale under 300 characters. ' +
              'Do not infer sensitive traits.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              firstPersona: a,
              secondPersona: b,
              conversation: history.slice(-16).map(turn => ({
                senderName: turn.senderName,
                content: turn.content.slice(0, 600),
              })),
            }, (_key, value) => typeof value === 'bigint' ? value.toString() : value),
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'compatibility_verdict',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                score: { type: 'integer', minimum: 0, maximum: 100 },
                rationale: { type: 'string' },
              },
              required: ['score', 'rationale'],
              additionalProperties: false,
            },
          },
        },
        max_completion_tokens: 2_000,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`Verdict generation failed with status ${response.status}`);
    }
    const payload = (await response.json()) as ChatCompletionResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error('Model returned no verdict');
    }
    const verdict = JSON.parse(content) as { score?: unknown; rationale?: unknown };
    if (
      typeof verdict.score !== 'number' ||
      !Number.isInteger(verdict.score) ||
      verdict.score < 0 ||
      verdict.score > 100 ||
      typeof verdict.rationale !== 'string' ||
      verdict.rationale.trim().length === 0
    ) {
      throw new Error('Model returned an invalid verdict');
    }
    return {
      rawScore: verdict.score,
      signalStrength: verdict.score,
      reason: verdict.rationale.trim().slice(0, 300),
      model: process.env.OPENAI_MODEL ?? 'gpt-5-nano',
    };
  }

  return scorePlaceholder(a, b, history);
}

function scorePlaceholder(
  a: PersonaLike,
  b: PersonaLike,
  history: Turn[],
): ConversationScore {
  const sharedInterests = overlap(a.interests, b.interests);
  const sharedValues = overlap(a.values, b.values);
  const styleMatch = norm(a.socialStyle) === norm(b.socialStyle) && a.socialStyle.length > 0;
  const participants = new Set(history.map(turn => turn.senderPersonaId.toString()));
  const conversationEvidence =
    Math.min(12, history.length * 2) + (participants.size >= 2 ? 4 : 0);

  const rawScore = clamp(
    Math.round(
      18 +
        sharedInterests.length * 13 +
        sharedValues.length * 11 +
        (styleMatch ? 8 : 0) +
        conversationEvidence +
        jitter(a.id, b.id),
    ),
    0,
    100,
  );
  const signalStrength = clamp(rawScore + 3, 0, 100);

  const reasonParts: string[] = [];
  if (sharedInterests.length > 0) reasonParts.push(`shared interest in ${sharedInterests.slice(0, 2).join(' & ')}`);
  if (sharedValues.length > 0) reasonParts.push(`aligned values (${sharedValues.slice(0, 2).join(', ')})`);
  if (styleMatch) reasonParts.push('similar social energy');
  const reason =
    reasonParts.length > 0
      ? `Strong fit — ${reasonParts.join('; ')}.`
      : `Friendly, easy rapport with room to grow.`;

  return { rawScore, signalStrength, reason, model: 'placeholder-conversation' };
}

// ── Placeholder helpers ──────────────────────────────────────────────────────

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function overlap(x: string[], y: string[]): string[] {
  const ys = new Set(y.map(norm));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of x) {
    const key = norm(item);
    if (ys.has(key) && !seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function pick<T>(arr: T[], fallback: T): T {
  return arr.length > 0 ? arr[0] : fallback;
}

/** Deterministic small jitter from the pair's ids, so scores never tie. */
function jitter(a: bigint, b: bigint): number {
  const mix = Number(((a + b) * 2654435761n) % 11n); // 0..10
  return mix - 5; // -5..+5
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * A warm, human, jargon-free line for the given turn index, spoken by `speaker`
 * to `counterpart`. Even indices open/probe, odd indices reply. Beyond the
 * scripted arc it falls back to a friendly filler so longer runs still read ok.
 */
function placeholderTurn(speaker: PersonaLike, counterpart: PersonaLike, turnIndex: number): string {
  const commonInterest = pick(overlap(speaker.interests, counterpart.interests), '');
  const commonValue = pick(overlap(speaker.values, counterpart.values), '');
  const myInterest = pick(speaker.interests, turnIndex === 0 ? 'trying new things' : 'meeting new people');
  const myValue = pick(speaker.values, turnIndex % 2 === 0 ? 'kindness' : 'honesty');

  switch (turnIndex) {
    case 0:
      return `Hey ${counterpart.displayName}! I'm ${speaker.displayName} — nice to meet you. What's been keeping you busy lately?`;
    case 1:
      return `Hi ${counterpart.displayName}! Good to meet you too. Honestly I've been really into ${myInterest} lately. How about you?`;
    case 2:
      return commonInterest
        ? `No way, I'm into ${commonInterest} too! What got you started with it?`
        : `Oh nice. For me it's ${myInterest} — I could talk about it for hours.`;
    case 3:
      return commonInterest
        ? `Ha, love that we overlap there. I got into it a couple years back and it kind of stuck.`
        : `That sounds fun! I've always wanted to try ${myInterest}. What do you love most about it?`;
    case 4:
      return `What matters most to you when you're picking who to spend time with?`;
    case 5:
      return commonValue
        ? `Big one for me is ${commonValue} — I need people who genuinely care about that.`
        : `I really value ${myValue}. People who are real with me. You?`;
    case 6:
      return commonValue
        ? `Same here, ${commonValue} is huge for me. Feels like we'd actually get each other.`
        : `Makes sense. I lean toward ${myValue} myself, so we'd balance each other out.`;
    case 7:
      return `This was such an easy chat, ${counterpart.displayName}. I'd genuinely love to hang out sometime.`;
    default:
      return commonInterest
        ? `Honestly ${counterpart.displayName}, the more we talk about ${commonInterest} the more I think we'd get along.`
        : `I'm really enjoying this, ${counterpart.displayName} — we should keep it going.`;
  }
}
