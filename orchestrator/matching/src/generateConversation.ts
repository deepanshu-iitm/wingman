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
import {
  generateAgentTurn as generateOpenAIAgentTurn,
  type ConversationMessage,
  type ConversationPhase,
  type TurnIntent,
} from '../../src/agent.js';
import { generateVerdict } from '../../src/verdict.js';

export type { ConversationPhase } from '../../src/agent.js';

/** Minimal persona shape the generator needs (subset of the `persona` row). */
export interface PersonaLike {
  id: bigint;
  displayName: string;
  summary: string;
  interests: string[];
  values: string[];
  socialStyle: string;
  voiceStyle: string;
  speechSample: string;
}

export interface Turn {
  senderPersonaId: bigint;
  senderName: string;
  content: string;
  source: 'agent' | 'human';
  /** The speaker's read on whether to keep going (agent turns only). */
  intent: TurnIntent;
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
  phase: ConversationPhase = 'flowing',
  fetchImpl: Fetch = fetch,
): Promise<Turn> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    try {
      const result = await generateOpenAIAgentTurn(
        speaker,
        counterpart.displayName,
        history.map(toConversationMessage),
        phase,
        apiKey,
        fetchImpl,
      );
      return {
        senderPersonaId: speaker.id,
        senderName: speaker.displayName,
        content: result.message,
        source: 'agent',
        intent: result.intent,
      };
    } catch (error) {
      console.warn('Agent generation failed; using placeholder turn.', error);
    }
  }

  const content = placeholderTurn(speaker, counterpart, history.length, phase);
  return {
    senderPersonaId: speaker.id,
    senderName: speaker.displayName,
    content,
    source: 'agent',
    // The placeholder can't judge the vibe, so it closes only when the loop has
    // moved it into the wrapping phase.
    intent: phase === 'wrapping' ? 'closing' : 'continue',
  };
}

/** Fewest agent turns before a conversation may close naturally. */
export function minTurns(): number {
  return Math.max(2, CONFIG.MIN_TURNS_PER_CONVO);
}

/** Hard ceiling on agent turns regardless of how the chat is flowing. */
export function maxTurns(): number {
  return Math.max(minTurns(), CONFIG.MAX_TURNS_PER_CONVO);
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
    try {
      const verdict = await generateVerdict(
        toPersonaDraft(a),
        toPersonaDraft(b),
        history.map(toConversationMessage),
        apiKey,
        fetchImpl,
      );
      return {
        rawScore: verdict.score,
        signalStrength: verdict.score,
        reason: verdict.rationale,
        model: process.env.OPENAI_MODEL ?? 'gpt-5.6-luna',
      };
    } catch (error) {
      console.warn('Verdict generation failed; using placeholder score.', error);
    }
  }

  return scorePlaceholder(a, b, history);
}

function toConversationMessage(turn: Turn): ConversationMessage {
  return {
    senderName: turn.senderName,
    content: turn.content,
    source: turn.source,
  };
}

function toPersonaDraft(persona: PersonaLike) {
  return {
    displayName: persona.displayName,
    summary: persona.summary,
    interests: persona.interests,
    values: persona.values,
    socialStyle: persona.socialStyle,
    voiceStyle: persona.voiceStyle,
    speechSample: persona.speechSample,
  };
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
function placeholderTurn(
  speaker: PersonaLike,
  counterpart: PersonaLike,
  turnIndex: number,
  phase: ConversationPhase = 'flowing',
): string {
  const commonInterest = pick(overlap(speaker.interests, counterpart.interests), '');
  const commonValue = pick(overlap(speaker.values, counterpart.values), '');
  const myInterest = pick(speaker.interests, turnIndex === 0 ? 'trying new things' : 'meeting new people');
  const myValue = pick(speaker.values, turnIndex % 2 === 0 ? 'kindness' : 'honesty');

  // In the wrapping phase, always land on a warm goodbye instead of the arc line.
  if (phase === 'wrapping') {
    return commonInterest
      ? `This was such an easy chat, ${counterpart.displayName} — we clearly both love ${commonInterest}. I'd genuinely love to hang out sometime. Let's do it soon!`
      : `Honestly ${counterpart.displayName}, this was really fun. I've got to run, but let's pick it back up soon — take care!`;
  }

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
