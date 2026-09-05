/**
 * Wingman matching orchestrator (server-side).
 *
 * SpacetimeDB reducers are deterministic and cannot call an LLM, so this private
 * service is what actually *generates* the agent-to-agent conversations. It:
 *   1. connects with its own stable service identity and registers itself as THE
 *      authorized orchestrator (the module gates all write reducers on this),
 *   2. watches for `match_session` rows in status 'matching',
 *   3. for each runnable `conversation`, generates the dialogue ONE turn at a
 *      time via `generateAgentTurn`, reading DB state before each turn so agents
 *      react to shared state (and yield to a human takeover),
 *   4. calls `finalizeSession` once every conversation is complete.
 *
 * The module owns all durable state + the ranking math; this service only
 * generates and paces. The `deadline_timer` watchdog in the module is the
 * crash-safety net if this process dies mid-run.
 */

import * as fs from 'node:fs';
import {
  DbConnection,
  type ErrorContext,
  type SubscriptionEventContext,
} from './module_bindings/index.js';
import { CONFIG } from './config.js';
import {
  generateAgentTurn,
  plannedTurnCount,
  scoreConversation,
  type PersonaLike,
  type Turn,
} from './generateConversation.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** JSON.stringify that survives bigint fields (persona ids). */
function jsonStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

/** Run async tasks with a bounded concurrency pool. */
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

function loadToken(): string | undefined {
  try {
    const tok = fs.readFileSync(CONFIG.TOKEN_FILE, 'utf8').trim();
    return tok.length > 0 ? tok : undefined;
  } catch {
    return undefined;
  }
}

function saveToken(token: string): void {
  try {
    fs.writeFileSync(CONFIG.TOKEN_FILE, token, 'utf8');
  } catch (err) {
    console.warn('Could not persist token:', err);
  }
}

function toPersonaLike(row: {
  id: bigint;
  displayName: string;
  summary: string;
  interests: string[];
  values: string[];
  socialStyle: string;
}): PersonaLike {
  return {
    id: row.id,
    displayName: row.displayName,
    summary: row.summary,
    interests: [...row.interests],
    values: [...row.values],
    socialStyle: row.socialStyle,
  };
}

/** Full persona comes through the orchestrator-only view (persona is private). */
function findPersonaLike(conn: DbConnection, id: bigint): PersonaLike | null {
  const row = [...conn.db.orchestratorPersona.iter()].find((p) => p.id === id);
  return row ? toPersonaLike(row) : null;
}

function sessionConversations(conn: DbConnection, sessionId: bigint) {
  return [...conn.db.conversation.iter()].filter((c) => c.sessionId === sessionId);
}

function currentMessages(conn: DbConnection, conversationId: bigint) {
  return [...conn.db.message.iter()]
    .filter((m) => m.conversationId === conversationId)
    .sort((a, b) => a.seq - b.seq);
}

// ── Session processing ──────────────────────────────────────────────────────

/** Sessions we're actively working on, so we never double-run them concurrently. */
const claimed = new Set<bigint>();
let liveConnection: DbConnection | undefined;

async function processSession(conn: DbConnection, sessionId: bigint): Promise<void> {
  if (claimed.has(sessionId)) return;
  claimed.add(sessionId);

  try {
    const session = conn.db.matchSession.id.find(sessionId);
    if (!session) {
      console.warn(`Session ${sessionId} not found; skipping.`);
      return;
    }
    if (session.status !== 'matching') return;

    // Conversations are inserted in the same tx as the session, but table
    // callbacks can fire in any order — briefly wait until all rows are visible.
    const expected = Number(session.totalConversations);
    let all = sessionConversations(conn, sessionId);
    for (let tries = 0; all.length < expected && tries < 20; tries++) {
      await sleep(100);
      all = sessionConversations(conn, sessionId);
    }

    // Runnable = anything not yet complete. Includes 'active' rows so a restart
    // resumes a conversation mid-flight instead of abandoning it.
    const runnable = all.filter((c) => c.status !== 'complete').map((c) => c.id);
    if (runnable.length === 0) {
      console.log(`Session ${sessionId}: nothing to run; letting module finalize.`);
      await safeFinalize(conn, sessionId);
      return;
    }

    console.log(`Session ${sessionId}: running ${runnable.length} conversation(s)…`);
    await runPool(runnable, CONFIG.CONCURRENCY, (id) => runConversation(conn, sessionId, id));

    console.log(`Session ${sessionId}: all conversations complete → finalizing.`);
    await safeFinalize(conn, sessionId);
  } catch (err) {
    console.error(`Session ${sessionId} failed:`, err);
  } finally {
    // Drop the claim so a transient failure can be retried on the next scan.
    // Finished sessions are safe: the status guard above short-circuits re-entry.
    claimed.delete(sessionId);
  }
}

async function runConversation(conn: DbConnection, sessionId: bigint, conversationId: bigint): Promise<void> {
  const convo0 = conn.db.conversation.id.find(conversationId);
  if (!convo0 || convo0.status === 'complete') return;

  const a = findPersonaLike(conn, convo0.initiatorPersonaId);
  const b = findPersonaLike(conn, convo0.partnerPersonaId);
  if (!a || !b) {
    throw new Error(`Conversation ${conversationId}: missing persona data`);
  }

  const planned = plannedTurnCount();

  // Rebuild history + next sequence from what's already written (resume-safe).
  const existing = currentMessages(conn, conversationId);
  if (convo0.controlMode === 'human') {
    console.log(`Conversation ${conversationId}: human takeover — agent yields.`);
    return;
  }
  const history: Turn[] = existing.map((m) => ({
    senderPersonaId: m.senderPersonaId,
    senderName: m.senderName,
    content: m.content,
    source: m.source === 'human' ? 'human' : 'agent',
  }));
  const nextSeq = existing.reduce((max, message) => Math.max(max, message.seq + 1), 0);

  for (let seq = nextSeq; history.length < planned; seq++) {
    // Read current state before every turn: stop if finalized or taken over.
    const convo = conn.db.conversation.id.find(conversationId);
    if (!convo || convo.status === 'complete') return; // finalized elsewhere (deadline)
    if (convo.controlMode === 'human') {
      console.log(`Conversation ${conversationId}: human takeover mid-run — agent yields.`);
      return;
    }

    const lastSpeakerId = history.at(-1)?.senderPersonaId;
    const speaker = lastSpeakerId === a.id ? b : a;
    const counterpart = speaker.id === a.id ? b : a;
    const turn = await generateAgentTurn(speaker, counterpart, history);

    await conn.reducers.appendMessage({
      conversationId,
      senderPersonaId: turn.senderPersonaId,
      senderName: turn.senderName,
      content: turn.content.slice(0, 2000),
      seq,
    });
    history.push(turn);

    if (seq % CONFIG.SIGNAL_UPDATE_EVERY === 0 || seq === planned - 1) {
      const progress = (seq + 1) / planned;
      const ramped = Math.round(70 * progress);
      await conn.reducers.updateSignal({ conversationId, signalStrength: ramped });
    }

    await sleep(CONFIG.PACING_MS);
  }

  const score = await scoreConversation(a, b, history);
  await conn.reducers.completeConversation({
    conversationId,
    rawScore: score.rawScore,
    signalStrength: score.signalStrength,
    reason: score.reason,
  });

  await conn.reducers.archiveConversation({
    sessionId,
    initiatorPersonaId: a.id,
    partnerPersonaId: b.id,
    personaSnapshot: jsonStringify({ a, b }),
    transcript: jsonStringify(history.map((t) => ({ sender: t.senderName, text: t.content }))),
    rawScore: score.rawScore,
    signalStrength: score.signalStrength,
    reason: score.reason,
    model: score.model,
  });
}

async function safeFinalize(conn: DbConnection, sessionId: bigint): Promise<void> {
  try {
    await conn.reducers.finalizeSession({ sessionId });
  } catch (err) {
    // Idempotent in the module; the watchdog is the backstop.
    console.warn(`finalizeSession(${sessionId}) failed:`, err);
  }
}

// ── Connect + subscribe ───────────────────────────────────────────────────────

function scanForWork(conn: DbConnection): void {
  for (const session of conn.db.matchSession.iter()) {
    if (session.status === 'matching' && !claimed.has(session.id)) {
      void processSession(conn, session.id);
    }
  }
}

const builder = DbConnection.builder()
  .withUri(CONFIG.SPACETIMEDB_URI)
  .withDatabaseName(CONFIG.MODULE_NAME)
  .onConnect((conn: DbConnection, identity, token) => {
    liveConnection = conn;
    saveToken(token);
    console.log('Orchestrator connected.');
    console.log('  Identity:', identity.toHexString());
    console.log('  Module  :', CONFIG.MODULE_NAME);

    conn
      .subscriptionBuilder()
      .onApplied((ctx: SubscriptionEventContext) => {
        console.log(
          `Subscription applied — ${[...ctx.db.orchestratorPersona.iter()].length} persona(s), ` +
            `${[...ctx.db.matchSession.iter()].length} session(s).`,
        );
        scanForWork(conn);
      })
      .onError((ctx: ErrorContext) => {
        console.error('Subscription error:', ctx.event);
      })
      .subscribe([
        'SELECT * FROM orchestrator_persona',
        'SELECT * FROM match_session',
        'SELECT * FROM conversation',
        'SELECT * FROM message',
      ]);

    // New "Match Me" clicks arrive as fresh sessions.
    conn.db.matchSession.onInsert((_ctx, row) => {
      if (row.status === 'matching') void processSession(conn, row.id);
    });
  })
  .onConnectError((_ctx: ErrorContext, error: Error) => {
    console.error('Connection error:', error);
    process.exit(1);
  });

const savedToken = loadToken();
if (savedToken) builder.withToken(savedToken);

builder.build();

const retryTimer = setInterval(() => {
  if (liveConnection) scanForWork(liveConnection);
}, CONFIG.RETRY_SCAN_MS);
retryTimer.unref();

console.log(`Connecting to ${CONFIG.SPACETIMEDB_URI} (${CONFIG.MODULE_NAME})…`);
