/**
 * Wingman — "Match Me" agent matching engine (SpacetimeDB module).
 *
 * The module owns ALL durable state and the ranking/calibration math.
 * It never calls an LLM (reducers are deterministic, no network I/O) — the
 * matching orchestrator service generates conversations and writes them back
 * through the reducers below.
 *
 * Naming: schema keys + table `name` are snake_case (SQL + ctx.db accessor);
 * columns are camelCase. Status fields are plain strings compared with `===`.
 */

import {
  schema,
  table,
  t,
  SenderError,
  type InferSchema,
  type ReducerCtx,
} from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';

// ── Constants ───────────────────────────────────────────────────────────────
const MATCH_DEADLINE_MICROS = 180_000_000n; // 3 minutes
const MAX_MESSAGE_LEN = 2000;
const TOP_N_RESULTS = 3;

// ── Tables ────────────────────────────────────────────────────────────────────

/** The agents. Shared contract with the persona-extraction side (PersonaDraft). */
const persona = table(
  { name: 'persona', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    owner: t.identity().index('btree'),
    displayName: t.string(),
    summary: t.string(),
    interests: t.array(t.string()),
    values: t.array(t.string()),
    socialStyle: t.string(),
    status: t.string(), // 'available' | 'matching'
    createdAt: t.timestamp(),
  }
);

/** One per "Match Me" click. */
const match_session = table(
  { name: 'match_session', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    owner: t.identity(),
    initiatorPersonaId: t.u64(),
    status: t.string(), // 'matching' | 'complete'
    totalConversations: t.u32(),
    startedAt: t.timestamp(),
    deadlineMicros: t.u64(),
    createdAt: t.timestamp(),
  }
);

/** One per pair; carries live signal strength, final scores, and rank. */
const conversation = table(
  { name: 'conversation', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64().index('btree'),
    initiatorPersonaId: t.u64(),
    partnerPersonaId: t.u64(),
    partnerDisplayName: t.string(),
    status: t.string(), // 'pending' | 'active' | 'complete'
    signalStrength: t.u32(), // 0..100
    turnCount: t.u32(),
    rawScore: t.option(t.u32()),
    displayScore: t.option(t.u32()),
    reason: t.option(t.string()),
    rank: t.option(t.u32()),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

/** Streamed chat turns. */
const message = table(
  { name: 'message', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    conversationId: t.u64().index('btree'),
    sessionId: t.u64().index('btree'),
    senderPersonaId: t.u64(),
    senderName: t.string(),
    content: t.string(),
    source: t.string(), // 'agent' | 'human'
    seq: t.u32(),
    createdAt: t.timestamp(),
  }
);

/** The top-3 output. */
const match_result = table(
  { name: 'match_result', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64().index('btree'),
    partnerPersonaId: t.u64(),
    partnerDisplayName: t.string(),
    rank: t.u32(),
    displayScore: t.u32(),
    reason: t.string(),
    conversationId: t.u64(),
    createdAt: t.timestamp(),
  }
);

/** Training data — every conversation, denormalized. Private (not client-read). */
const conversation_archive = table(
  { name: 'conversation_archive', public: false },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64(),
    initiatorPersonaId: t.u64(),
    partnerPersonaId: t.u64(),
    personaSnapshot: t.string(), // JSON
    transcript: t.string(), // JSON [{sender,text}]
    rawScore: t.u32(),
    signalStrength: t.u32(),
    reason: t.string(),
    model: t.string(), // 'placeholder' | 'gpt-4o-mini' | ...
    createdAt: t.timestamp(),
  }
);

/** Scheduled 3-minute watchdog. Private. */
const deadline_timer = table(
  {
    name: 'deadline_timer',
    scheduled: (): any => finalizeDeadline,
  },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    sessionId: t.u64(),
  }
);

const spacetimedb = schema({
  persona,
  match_session,
  conversation,
  message,
  match_result,
  conversation_archive,
  deadline_timer,
});
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

// ── Lifecycle ─────────────────────────────────────────────────────────────────
export const init = spacetimedb.init(_ctx => {});
export const onConnect = spacetimedb.clientConnected(_ctx => {});
export const onDisconnect = spacetimedb.clientDisconnected(_ctx => {});

// ── Calibration ────────────────────────────────────────────────────────────────
/**
 * Deterministic display-score calibration. Guarantees display[0] >= 85,
 * strictly descending, natural spread in ~88..97. Honest raw scores are kept
 * separately on the conversation + archive rows.
 */
function calibrateDisplay(rankedRaw: number[]): number[] {
  const CEIL = 97;
  const TOPMIN = 88;
  const MINGAP = 2;
  const out: number[] = [];
  const top = rankedRaw[0] ?? 0;
  out[0] = Math.min(CEIL, Math.max(TOPMIN, Math.round(TOPMIN + (top / 100) * (CEIL - TOPMIN))));
  for (let i = 1; i < rankedRaw.length; i++) {
    const gap = Math.max(0, rankedRaw[i - 1] - rankedRaw[i]);
    const step = Math.min(6, Math.max(MINGAP, Math.round(2 + gap * 0.15)));
    out[i] = Math.max(40, out[i - 1] - step);
  }
  return out;
}

/**
 * Shared finalize logic — called by both the normal finish (finalizeSession)
 * and the watchdog (finalizeDeadline). Idempotent: no-ops if already complete.
 */
function finalizeSessionInternal(ctx: Ctx, sessionId: bigint): void {
  const session = ctx.db.match_session.id.find(sessionId);
  if (!session || session.status === 'complete') return;

  const convos = [...ctx.db.conversation.sessionId.filter(sessionId)]
    .filter(c => c.status === 'complete' && c.rawScore !== undefined)
    .sort((a, b) => (b.rawScore as number) - (a.rawScore as number));

  const displays = calibrateDisplay(convos.map(c => c.rawScore as number));
  const topN = Math.min(TOP_N_RESULTS, convos.length);

  for (let i = 0; i < convos.length; i++) {
    const c = convos[i];
    const display = displays[i];
    ctx.db.conversation.id.update({
      ...c,
      displayScore: display,
      rank: i + 1,
      updatedAt: ctx.timestamp,
    });
    if (i < topN) {
      ctx.db.match_result.insert({
        id: 0n,
        sessionId,
        partnerPersonaId: c.partnerPersonaId,
        partnerDisplayName: c.partnerDisplayName,
        rank: i + 1,
        displayScore: display,
        reason: c.reason ?? '',
        conversationId: c.id,
        createdAt: ctx.timestamp,
      });
    }
  }

  ctx.db.match_session.id.update({ ...session, status: 'complete' });
}

// ── Reducers: persona (text/manual onboarding fallback) ──────────────────────────
export const createPersona = spacetimedb.reducer(
  {
    displayName: t.string(),
    summary: t.string(),
    interests: t.array(t.string()),
    values: t.array(t.string()),
    socialStyle: t.string(),
  },
  (ctx, { displayName, summary, interests, values, socialStyle }) => {
    if (displayName.trim().length === 0) throw new SenderError('displayName required');
    ctx.db.persona.insert({
      id: 0n,
      owner: ctx.sender,
      displayName,
      summary,
      interests,
      values,
      socialStyle,
      status: 'available',
      createdAt: ctx.timestamp,
    });
  }
);

// ── Reducers: client-called ──────────────────────────────────────────────────────
export const startMatch = spacetimedb.reducer(
  { personaId: t.u64() },
  (ctx, { personaId }) => {
    const me = ctx.db.persona.id.find(personaId);
    if (!me) throw new SenderError('persona not found');
    if (!me.owner.equals(ctx.sender)) throw new SenderError('not your persona');

    const others = [...ctx.db.persona.iter()].filter(p => p.id !== personaId);
    const now = ctx.timestamp;
    const deadlineMicros = now.microsSinceUnixEpoch + MATCH_DEADLINE_MICROS;

    const session = ctx.db.match_session.insert({
      id: 0n,
      owner: ctx.sender,
      initiatorPersonaId: personaId,
      status: others.length === 0 ? 'complete' : 'matching',
      totalConversations: others.length,
      startedAt: now,
      deadlineMicros,
      createdAt: now,
    });

    for (const other of others) {
      ctx.db.conversation.insert({
        id: 0n,
        sessionId: session.id,
        initiatorPersonaId: personaId,
        partnerPersonaId: other.id,
        partnerDisplayName: other.displayName,
        status: 'pending',
        signalStrength: 0,
        turnCount: 0,
        rawScore: undefined,
        displayScore: undefined,
        reason: undefined,
        rank: undefined,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (others.length > 0) {
      ctx.db.deadline_timer.insert({
        scheduledId: 0n,
        scheduledAt: ScheduleAt.time(deadlineMicros),
        sessionId: session.id,
      });
    }
  }
);

// ── Reducers: orchestrator-called ────────────────────────────────────────────────
// MVP auth: these validate data integrity + idempotency but do not gate on
// identity (acceptable for a 24h demo). To lock down: check ctx.sender against a
// known ORCHESTRATOR_IDENTITY (or the session owner) before mutating.

export const appendMessage = spacetimedb.reducer(
  {
    conversationId: t.u64(),
    senderPersonaId: t.u64(),
    senderName: t.string(),
    content: t.string(),
    source: t.string(),
    seq: t.u32(),
  },
  (ctx, { conversationId, senderPersonaId, senderName, content, source, seq }) => {
    const convo = ctx.db.conversation.id.find(conversationId);
    if (!convo) throw new SenderError('conversation not found');
    if (convo.status === 'complete') return; // late write, ignore
    if (content.length > MAX_MESSAGE_LEN) throw new SenderError('message too long');

    // Idempotency: one message per (conversationId, seq).
    const dup = [...ctx.db.message.conversationId.filter(conversationId)].some(m => m.seq === seq);
    if (dup) return;

    ctx.db.message.insert({
      id: 0n,
      conversationId,
      sessionId: convo.sessionId,
      senderPersonaId,
      senderName,
      content,
      source,
      seq,
      createdAt: ctx.timestamp,
    });

    ctx.db.conversation.id.update({
      ...convo,
      status: 'active',
      turnCount: seq + 1,
      updatedAt: ctx.timestamp,
    });
  }
);

export const updateSignal = spacetimedb.reducer(
  { conversationId: t.u64(), signalStrength: t.u32() },
  (ctx, { conversationId, signalStrength }) => {
    const convo = ctx.db.conversation.id.find(conversationId);
    if (!convo) throw new SenderError('conversation not found');
    const clamped = Math.max(0, Math.min(100, signalStrength));
    ctx.db.conversation.id.update({
      ...convo,
      signalStrength: clamped,
      updatedAt: ctx.timestamp,
    });
  }
);

export const completeConversation = spacetimedb.reducer(
  {
    conversationId: t.u64(),
    rawScore: t.u32(),
    signalStrength: t.u32(),
    reason: t.string(),
  },
  (ctx, { conversationId, rawScore, signalStrength, reason }) => {
    const convo = ctx.db.conversation.id.find(conversationId);
    if (!convo) throw new SenderError('conversation not found');
    if (convo.status === 'complete') return;
    ctx.db.conversation.id.update({
      ...convo,
      status: 'complete',
      rawScore: Math.max(0, Math.min(100, rawScore)),
      signalStrength: Math.max(0, Math.min(100, signalStrength)),
      reason,
      updatedAt: ctx.timestamp,
    });
  }
);

export const archiveConversation = spacetimedb.reducer(
  {
    sessionId: t.u64(),
    initiatorPersonaId: t.u64(),
    partnerPersonaId: t.u64(),
    personaSnapshot: t.string(),
    transcript: t.string(),
    rawScore: t.u32(),
    signalStrength: t.u32(),
    reason: t.string(),
    model: t.string(),
  },
  (ctx, a) => {
    ctx.db.conversation_archive.insert({
      id: 0n,
      sessionId: a.sessionId,
      initiatorPersonaId: a.initiatorPersonaId,
      partnerPersonaId: a.partnerPersonaId,
      personaSnapshot: a.personaSnapshot,
      transcript: a.transcript,
      rawScore: a.rawScore,
      signalStrength: a.signalStrength,
      reason: a.reason,
      model: a.model,
      createdAt: ctx.timestamp,
    });
  }
);

export const finalizeSession = spacetimedb.reducer(
  { sessionId: t.u64() },
  (ctx, { sessionId }) => {
    finalizeSessionInternal(ctx, sessionId);
  }
);

// ── Scheduled: 3-minute watchdog ─────────────────────────────────────────────────
export const finalizeDeadline = spacetimedb.reducer(
  { timer: deadline_timer.rowType },
  (ctx, { timer }) => {
    finalizeSessionInternal(ctx, timer.sessionId);
  }
);
