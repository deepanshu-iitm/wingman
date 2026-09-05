/**
 * Wingman — "Match Me" agent matching engine (SpacetimeDB module).
 *
 * The module owns ALL durable state and the ranking math. It never calls an LLM
 * (reducers are deterministic, no network I/O) — the matching orchestrator
 * service generates conversations and writes them back through the reducers
 * below.
 *
 * Naming: schema keys + table `name` are snake_case (SQL + ctx.db accessor);
 * columns are camelCase. Status fields are plain strings compared with `===`.
 *
 * Product note: we show only ranked matches ("top match" / "top 3"), NOT a
 * compatibility percentage. Raw scores are kept internally for ranking and for
 * training data, but are never surfaced as a "% compatible" number.
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
const MAX_MATCH_CANDIDATES = 25; // cap fan-out (and downstream LLM cost) per click

// ── Tables ────────────────────────────────────────────────────────────────────

/**
 * The agents. PRIVATE — full persona data (summary, interests, values, social
 * style, owner identity) is never client-readable directly. Clients read it
 * through the scoped views below:
 *   • `my_persona`           — the owner's own full personas,
 *   • `public_persona`       — a minimal spectator projection (id/name/status),
 *   • `orchestrator_persona` — full data, only to the registered orchestrator.
 * Shared contract with the persona-extraction side (PersonaDraft).
 */
const persona = table(
  { name: 'persona', public: false },
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
    status: t.string(), // 'matching' | 'complete' | 'timed_out'
    totalConversations: t.u32(),
    startedAt: t.timestamp(),
    deadlineMicros: t.u64(),
    createdAt: t.timestamp(),
  }
);

/** One per pair; carries public live state and final rank. */
const conversation = table(
  { name: 'conversation', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64().index('btree'),
    initiatorPersonaId: t.u64(),
    partnerPersonaId: t.u64(),
    partnerDisplayName: t.string(),
    status: t.string(), // 'pending' | 'active' | 'complete'
    signalStrength: t.u32(), // 0..100 — live directional indicator (NOT a %match)
    turnCount: t.u32(),
    controlMode: t.string(), // 'agent' | 'human'
    humanPersonaId: t.option(t.u64()),
    reason: t.option(t.string()),
    rank: t.option(t.u32()),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

/** Private scoring state, separated from the public conversation projection. */
const conversation_score = table(
  { name: 'conversation_score', public: false },
  {
    conversationId: t.u64().primaryKey(),
    rawScore: t.u32(),
  }
);

/** Streamed chat turns. `source` 'human' marks a takeover turn. */
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

/** The top-N output — a pure ranking (no compatibility percentage). */
const match_result = table(
  { name: 'match_result', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64().index('btree'),
    partnerPersonaId: t.u64(),
    partnerDisplayName: t.string(),
    rank: t.u32(),
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

/**
 * Single-row config holding the module admin and authorized orchestrator.
 * The publishing identity is recorded during init and is the only identity
 * allowed to provision the worker.
 */
const orchestrator_config = table(
  { name: 'orchestrator_config', public: false },
  {
    id: t.u8().primaryKey(), // always 0 — single row
    adminIdentity: t.identity(),
    orchestratorIdentity: t.option(t.identity()),
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
  conversation_score,
  message,
  match_result,
  conversation_archive,
  orchestrator_config,
  deadline_timer,
});
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

// ── Lifecycle ─────────────────────────────────────────────────────────────────
export const init = spacetimedb.init(ctx => {
  ctx.db.orchestrator_config.insert({
    id: 0,
    adminIdentity: ctx.sender,
    orchestratorIdentity: undefined,
  });
});
export const onConnect = spacetimedb.clientConnected(_ctx => {});
export const onDisconnect = spacetimedb.clientDisconnected(_ctx => {});

// ── Views: scoped persona access ─────────────────────────────────────────────────

/** Minimal spectator projection — what a live watcher may see about any agent. */
const PublicPersonaRow = t.object('PublicPersonaRow', {
  id: t.u64(),
  displayName: t.string(),
  status: t.string(),
});

export const publicPersona = spacetimedb.anonymousView(
  { name: 'public_persona', public: true },
  t.array(PublicPersonaRow),
  (ctx) =>
    [...ctx.db.persona.iter()].map(p => ({
      id: p.id,
      displayName: p.displayName,
      status: p.status,
    }))
);

/** The caller's own full personas (per-user; keyed on ctx.sender). */
export const myPersona = spacetimedb.view(
  { name: 'my_persona', public: true },
  t.array(persona.rowType),
  (ctx) => [...ctx.db.persona.iter()].filter(p => p.owner.equals(ctx.sender))
);

/** Full persona data — only ever returned to the registered orchestrator. */
export const orchestratorPersona = spacetimedb.view(
  { name: 'orchestrator_persona', public: true },
  t.array(persona.rowType),
  (ctx) => {
    const cfg = ctx.db.orchestrator_config.id.find(0);
    return cfg?.orchestratorIdentity?.equals(ctx.sender)
      ? [...ctx.db.persona.iter()]
      : [];
  }
);

// ── Row-level visibility filters ─────────────────────────────────────────────
//
// These enforce the conversation privacy guarantee at the SpacetimeDB layer:
// a client receives ONLY the rows it is authorised to see, regardless of what
// SQL query it subscribes with. "SELECT * + filter client-side" is not used.
//
// The orchestrator identity is always exempted so the matching service can
// subscribe to all rows it needs to drive conversations.

const ORCH_CHECK =
  `EXISTS (SELECT 1 FROM orchestrator_config WHERE id = 0 AND orchestratorIdentity = :sender)`;

/** A client sees only their own match sessions (or the orchestrator sees all). */
export const matchSessionVisibility = spacetimedb.clientVisibilityFilter.sql(`
  SELECT * FROM match_session
  WHERE owner = :sender
     OR ${ORCH_CHECK}
`);

/**
 * A client sees a conversation only if they own the initiator persona OR the
 * partner persona. The orchestrator sees all.
 */
export const conversationVisibility = spacetimedb.clientVisibilityFilter.sql(`
  SELECT c.* FROM conversation c
  WHERE ${ORCH_CHECK}
     OR EXISTS (SELECT 1 FROM persona p WHERE p.id = c.initiatorPersonaId AND p.owner = :sender)
     OR EXISTS (SELECT 1 FROM persona p WHERE p.id = c.partnerPersonaId  AND p.owner = :sender)
`);

/**
 * A client sees a message only if they can see its parent conversation.
 * Derived from the same persona-ownership rule; the orchestrator sees all.
 */
export const messageVisibility = spacetimedb.clientVisibilityFilter.sql(`
  SELECT m.* FROM message m
  WHERE ${ORCH_CHECK}
     OR EXISTS (
       SELECT 1 FROM conversation c
       WHERE c.id = m.conversationId
         AND (
           EXISTS (SELECT 1 FROM persona p WHERE p.id = c.initiatorPersonaId AND p.owner = :sender)
           OR EXISTS (SELECT 1 FROM persona p WHERE p.id = c.partnerPersonaId  AND p.owner = :sender)
         )
     )
`);

/** A client sees match results only for their own sessions (or the orchestrator sees all). */
export const matchResultVisibility = spacetimedb.clientVisibilityFilter.sql(`
  SELECT mr.* FROM match_result mr
  WHERE ${ORCH_CHECK}
     OR EXISTS (SELECT 1 FROM match_session ms WHERE ms.id = mr.sessionId AND ms.owner = :sender)
`);

// ── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Gate for orchestrator-only reducers. Compares the registered orchestrator
 * identity against ctx.sender — never trusts an identity passed as an argument.
 */
function requireOrchestrator(ctx: Ctx): void {
  const cfg = ctx.db.orchestrator_config.id.find(0);
  if (!cfg?.orchestratorIdentity?.equals(ctx.sender)) {
    throw new SenderError('unauthorized: orchestrator only');
  }
}

/**
 * Provision the worker identity. Only the module publisher recorded at init
 * may set or rotate it.
 */
export const registerOrchestrator = spacetimedb.reducer(
  { orchestratorIdentity: t.identity() },
  (ctx, { orchestratorIdentity }) => {
    const config = ctx.db.orchestrator_config.id.find(0);
    if (!config || !config.adminIdentity.equals(ctx.sender)) {
      throw new SenderError('unauthorized: module admin only');
    }
    ctx.db.orchestrator_config.id.update({
      ...config,
      orchestratorIdentity,
    });
  }
);

// ── Finalize (shared by normal finish + watchdog) ────────────────────────────────
/**
 * Ranks completed conversations by honest rawScore and writes the top-N
 * `match_result` rows (rank + reason only — no compatibility %). Idempotent:
 * no-ops once the session has left 'matching'.
 *
 * @param timedOut  false = normal finish (requires every conversation done);
 *                  true  = watchdog finish (finalizes whatever is available,
 *                          and marks the session 'timed_out' if incomplete).
 */
function finalizeSessionInternal(ctx: Ctx, sessionId: bigint, timedOut: boolean): void {
  const session = ctx.db.match_session.id.find(sessionId);
  if (!session || session.status !== 'matching') return;

  const total = Number(session.totalConversations);
  const convos = [...ctx.db.conversation.sessionId.filter(sessionId)]
    .filter(c => c.status === 'complete')
    .map(conversation => ({
      conversation,
      score: ctx.db.conversation_score.conversationId.find(conversation.id),
    }))
    .filter(
      (entry): entry is {
        conversation: typeof entry.conversation;
        score: NonNullable<typeof entry.score>;
      } => entry.score !== undefined
    )
    .sort((a, b) => b.score.rawScore - a.score.rawScore);

  // Normal path waits for a complete run; the watchdog finalizes partials.
  if (!timedOut && convos.length < total) return;

  const topN = Math.min(TOP_N_RESULTS, convos.length);
  for (let i = 0; i < convos.length; i++) {
    const c = convos[i].conversation;
    ctx.db.conversation.id.update({
      ...c,
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
        reason: c.reason ?? '',
        conversationId: c.id,
        createdAt: ctx.timestamp,
      });
    }
  }

  const finalStatus = convos.length >= total ? 'complete' : 'timed_out';
  ctx.db.match_session.id.update({ ...session, status: finalStatus });

  // Release the initiator persona so it can match again.
  const initiator = ctx.db.persona.id.find(session.initiatorPersonaId);
  if (initiator && initiator.status === 'matching') {
    ctx.db.persona.id.update({ ...initiator, status: 'available' });
  }
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
    // Reject duplicate fan-outs: repeated clicks would multiply LLM cost.
    if (me.status !== 'available') throw new SenderError('this persona is already matching');

    // Candidates: other users' available personas only, deterministic order, capped.
    const others = [...ctx.db.persona.iter()]
      .filter(p => p.id !== personaId && !p.owner.equals(ctx.sender) && p.status === 'available')
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, MAX_MATCH_CANDIDATES);

    const now = ctx.timestamp;
    const deadlineMicros = now.microsSinceUnixEpoch + MATCH_DEADLINE_MICROS;
    const willRun = others.length > 0;

    const session = ctx.db.match_session.insert({
      id: 0n,
      owner: ctx.sender,
      initiatorPersonaId: personaId,
      status: willRun ? 'matching' : 'complete',
      totalConversations: others.length,
      startedAt: now,
      deadlineMicros,
      createdAt: now,
    });

    if (!willRun) return; // nobody to match with — session is immediately complete

    ctx.db.persona.id.update({ ...me, status: 'matching' });

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
        controlMode: 'agent',
        humanPersonaId: undefined,
        reason: undefined,
        rank: undefined,
        createdAt: now,
        updatedAt: now,
      });
    }

    ctx.db.deadline_timer.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(deadlineMicros),
      sessionId: session.id,
    });
  }
);

// ── Reducers: orchestrator-called ────────────────────────────────────────────────
// All of these are gated by requireOrchestrator(ctx): only the registered
// orchestrator identity may forge messages, set scores, archive, or finalize.

export const appendMessage = spacetimedb.reducer(
  {
    conversationId: t.u64(),
    senderPersonaId: t.u64(),
    senderName: t.string(),
    content: t.string(),
    seq: t.u32(),
  },
  (ctx, { conversationId, senderPersonaId, senderName, content, seq }) => {
    requireOrchestrator(ctx);
    const convo = ctx.db.conversation.id.find(conversationId);
    if (!convo) throw new SenderError('conversation not found');
    if (convo.status === 'complete') return; // late write, ignore
    if (convo.controlMode === 'human') return; // takeover won the race
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
      source: 'agent',
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
    requireOrchestrator(ctx);
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
    requireOrchestrator(ctx);
    const convo = ctx.db.conversation.id.find(conversationId);
    if (!convo) throw new SenderError('conversation not found');
    if (convo.status === 'complete') return;
    if (convo.controlMode === 'human') return;
    const clampedRawScore = Math.max(0, Math.min(100, rawScore));
    const existingScore = ctx.db.conversation_score.conversationId.find(conversationId);
    if (existingScore) {
      ctx.db.conversation_score.conversationId.update({
        ...existingScore,
        rawScore: clampedRawScore,
      });
    } else {
      ctx.db.conversation_score.insert({ conversationId, rawScore: clampedRawScore });
    }
    ctx.db.conversation.id.update({
      ...convo,
      status: 'complete',
      signalStrength: Math.max(0, Math.min(100, signalStrength)),
      reason,
      updatedAt: ctx.timestamp,
    });
  }
);

function requireParticipant(
  ctx: Ctx,
  conversationId: bigint,
  personaId: bigint
) {
  const convo = ctx.db.conversation.id.find(conversationId);
  if (!convo) throw new SenderError('conversation not found');
  if (convo.status === 'complete') throw new SenderError('conversation is complete');
  if (
    personaId !== convo.initiatorPersonaId &&
    personaId !== convo.partnerPersonaId
  ) {
    throw new SenderError('persona is not part of this conversation');
  }
  const participant = ctx.db.persona.id.find(personaId);
  if (!participant || !participant.owner.equals(ctx.sender)) {
    throw new SenderError('not your persona');
  }
  return { convo, participant };
}

export const takeOverConversation = spacetimedb.reducer(
  { conversationId: t.u64(), personaId: t.u64() },
  (ctx, { conversationId, personaId }) => {
    const { convo } = requireParticipant(ctx, conversationId, personaId);
    ctx.db.conversation.id.update({
      ...convo,
      status: 'active',
      controlMode: 'human',
      humanPersonaId: personaId,
      updatedAt: ctx.timestamp,
    });
  }
);

export const sendHumanMessage = spacetimedb.reducer(
  { conversationId: t.u64(), personaId: t.u64(), content: t.string() },
  (ctx, { conversationId, personaId, content }) => {
    const { convo, participant } = requireParticipant(ctx, conversationId, personaId);
    if (
      convo.controlMode !== 'human' ||
      convo.humanPersonaId !== personaId
    ) {
      throw new SenderError('take over this conversation first');
    }
    const trimmed = content.trim();
    if (trimmed.length === 0) throw new SenderError('message required');
    if (trimmed.length > MAX_MESSAGE_LEN) throw new SenderError('message too long');

    const nextSeq = [...ctx.db.message.conversationId.filter(conversationId)]
      .reduce((max, row) => Math.max(max, row.seq + 1), 0);
    ctx.db.message.insert({
      id: 0n,
      conversationId,
      sessionId: convo.sessionId,
      senderPersonaId: personaId,
      senderName: participant.displayName,
      content: trimmed,
      source: 'human',
      seq: nextSeq,
      createdAt: ctx.timestamp,
    });
    ctx.db.conversation.id.update({
      ...convo,
      status: 'active',
      turnCount: nextSeq + 1,
      updatedAt: ctx.timestamp,
    });
  }
);

export const releaseConversation = spacetimedb.reducer(
  { conversationId: t.u64(), personaId: t.u64() },
  (ctx, { conversationId, personaId }) => {
    const { convo } = requireParticipant(ctx, conversationId, personaId);
    if (
      convo.controlMode !== 'human' ||
      convo.humanPersonaId !== personaId
    ) {
      throw new SenderError('you do not control this conversation');
    }
    ctx.db.conversation.id.update({
      ...convo,
      controlMode: 'agent',
      humanPersonaId: undefined,
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
    requireOrchestrator(ctx);
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
    requireOrchestrator(ctx);
    finalizeSessionInternal(ctx, sessionId, /* timedOut */ false);
  }
);

// ── Scheduled: 3-minute watchdog ─────────────────────────────────────────────────
export const finalizeDeadline = spacetimedb.reducer(
  { timer: deadline_timer.rowType },
  (ctx, { timer }) => {
    finalizeSessionInternal(ctx, timer.sessionId, /* timedOut */ true);
  }
);
