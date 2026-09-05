/**
 * The ONLY LLM-touching seam in the whole system.
 *
 * `generateConversation(A, B)` takes two personas and returns a full 1:1
 * conversation transcript plus scores. Today it runs in deterministic
 * **placeholder mode** (canned, persona-flavored dialogue + an overlap
 * heuristic) so the entire Match-Me flow works with no API key.
 *
 * To go live, swap `generatePlaceholder` for a single OpenAI call in
 * `generateConversation` — the return shape stays identical, so nothing else in
 * the orchestrator, module, or client changes. That LLM call is Deepanshu's
 * domain (see the team plan); keep it isolated here.
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

export interface GeneratedConversation {
  transcript: Turn[];
  /** Honest 0–100 compatibility signal (stored for training; calibrated later). */
  rawScore: number;
  /** Final 0–100 "signals" strength the UI ramps toward. */
  signalStrength: number;
  /** Short human-readable reason for the score. */
  reason: string;
  /** Which generator produced this ('placeholder' | 'gpt-4o-mini' | …). */
  model: string;
}

// ── Public seam ─────────────────────────────────────────────────────────────

export async function generateConversation(
  a: PersonaLike,
  b: PersonaLike,
): Promise<GeneratedConversation> {
  // LLM drop-in point. Example (Deepanshu):
  //   if (process.env.OPENAI_API_KEY) return generateWithLLM(a, b);
  return generatePlaceholder(a, b);
}

// ── Placeholder implementation ────────────────────────────────────────────────

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

function generatePlaceholder(a: PersonaLike, b: PersonaLike): GeneratedConversation {
  const sharedInterests = overlap(a.interests, b.interests);
  const sharedValues = overlap(a.values, b.values);
  const styleMatch = norm(a.socialStyle) === norm(b.socialStyle) && a.socialStyle.length > 0;

  // Honest overlap heuristic → 0..100.
  const rawScore = clamp(
    Math.round(
      34 +
        sharedInterests.length * 13 +
        sharedValues.length * 11 +
        (styleMatch ? 8 : 0) +
        jitter(a.id, b.id),
    ),
    0,
    100,
  );
  const signalStrength = clamp(rawScore + 3, 0, 100);

  const aInterest = pick(a.interests, 'trying new things');
  const bInterest = pick(b.interests, 'meeting new people');
  const commonInterest = pick(sharedInterests, '');
  const commonValue = pick(sharedValues, '');

  // A warm, human, jargon-free 1:1 opener → reply → probe → wrap.
  // Alternates A, B, A, B… and is trimmed/padded to CONFIG.TURNS_PER_CONVO.
  const script: Array<[PersonaLike, string]> = [
    [a, `Hey ${b.displayName}! I'm ${a.displayName} — nice to meet you. What's been keeping you busy lately?`],
    [b, `Hi ${a.displayName}! Good to meet you too. Honestly I've been really into ${bInterest} lately. How about you?`],
    [a, commonInterest
      ? `No way, I'm into ${commonInterest} too! What got you started with it?`
      : `Oh nice. For me it's ${aInterest} — I could talk about it for hours.`],
    [b, commonInterest
      ? `Ha, love that we overlap there. I got into it a couple years back and it kind of stuck.`
      : `That sounds fun! I've always wanted to try ${aInterest}. What do you love most about it?`],
    [a, `What matters most to you when you're picking who to spend time with?`],
    [b, commonValue
      ? `Big one for me is ${commonValue} — I need people who genuinely care about that.`
      : `I really value ${pick(b.values, 'honesty')}. People who are real with me. You?`],
    [a, commonValue
      ? `Same here, ${commonValue} is huge for me. Feels like we'd actually get each other.`
      : `Makes sense. I lean toward ${pick(a.values, 'kindness')} myself, so we'd balance each other out.`],
    [b, `This was such an easy chat, ${a.displayName}. I'd genuinely love to hang out sometime.`],
  ];

  const transcript: Turn[] = script
    .slice(0, Math.max(2, CONFIG.TURNS_PER_CONVO))
    .map(([speaker, content]) => ({
      senderPersonaId: speaker.id,
      senderName: speaker.displayName,
      content,
    }));

  const reasonParts: string[] = [];
  if (sharedInterests.length > 0) reasonParts.push(`shared interest in ${sharedInterests.slice(0, 2).join(' & ')}`);
  if (sharedValues.length > 0) reasonParts.push(`aligned values (${sharedValues.slice(0, 2).join(', ')})`);
  if (styleMatch) reasonParts.push('similar social energy');
  const reason =
    reasonParts.length > 0
      ? `Strong fit — ${reasonParts.join('; ')}.`
      : `Friendly, easy rapport with room to grow.`;

  return { transcript, rawScore, signalStrength, reason, model: 'placeholder' };
}
