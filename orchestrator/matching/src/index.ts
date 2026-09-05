/**
 * Wingman matching orchestrator (server-side).
 *
 * SpacetimeDB reducers are deterministic and cannot call an LLM, so this private
 * service is what actually *generates* the agent-to-agent conversations. It:
 *   1. connects to SpacetimeDB with its own stable service identity,
 *   2. watches for `match_session` rows in status 'matching',
 *   3. for each pending `conversation`, calls `generateConversation(A, B)`
 *      (placeholder now, LLM later) and plays the transcript back into the DB
 *      at a human pace via reducers, ramping the live "signal",
 *   4. calls `finalizeSession` once every conversation is complete.
 *
 * The module owns all durable state + the ranking/calibration math; this service
 * only generates and paces. The `deadline_timer` watchdog in the module is the
 * crash-safety net if this process dies mid-run.
 */

import * as fs from 'node:fs';
import {
  DbConnection,
  type ErrorContext,
  type SubscriptionEventContext,
} from '../../../src/module_bindings/index.js';
import { CONFIG } from './config.js';
import {
  generateConversation,
  type PersonaLike,
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

// ── Session processing ──────────────────────────────────────────────────────

/** Sessions we've already started working on, so we never double-run them. */
const claimed = new Set<bigint>();

async function processSession(conn: DbConnection, sessionId: bigint): Promise<void> {
  if (claimed.has(sessionId)) return;
  claimed.add(sessionId);

  const session = conn.db.matchSession.id.find(sessionId);
  if (!session) {
    console.warn(`Session ${sessionId} not found; skipping.`);
    return;
  }
  if (session.status !== 'matching') return;

  // Conversations are inserted in the same tx as the session, but table
  // callbacks can fire in any order — briefly wait until all rows are visible.
  const expected = Number(session.totalConversations);
  let pending = pendingConversations(conn, sessionId);
  for (let tries = 0; pending.length < expected && tries < 20; tries++) {
    await sleep(100);
    pending = pendingConversations(conn, sessionId);
  }

  if (pending.length === 0) {
    console.log(`Session ${sessionId}: no conversations to run; letting module finalize.`);
    await safeFinalize(conn, sessionId);
    return;
  }

  console.log(`Session ${sessionId}: running ${pending.length} conversation(s)…`);
  await runPool(pending, CONFIG.CONCURRENCY, (convId) => runConversation(conn, sessionId, convId));

  console.log(`Session ${sessionId}: all conversations complete → finalizing.`);
  await safeFinalize(conn, sessionId);
}

function pendingConversations(conn: DbConnection, sessionId: bigint): bigint[] {
  return [...conn.db.conversation.iter()]
    .filter((c) => c.sessionId === sessionId && c.status === 'pending')
    .map((c) => c.id);
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

async function runConversation(conn: DbConnection, sessionId: bigint, conversationId: bigint): Promise<void> {
  const convo = conn.db.conversation.id.find(conversationId);
  if (!convo) return;

  const personaA = conn.db.persona.id.find(convo.initiatorPersonaId);
  const personaB = conn.db.persona.id.find(convo.partnerPersonaId);
  if (!personaA || !personaB) {
    console.warn(`Conversation ${conversationId}: missing persona; skipping.`);
    return;
  }

  const a = toPersonaLike(personaA);
  const b = toPersonaLike(personaB);

  const result = await generateConversation(a, b);

  // Paced playback: stream each turn, ramping the live signal toward its final.
  const turns = result.transcript;
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    await conn.reducers.appendMessage({
      conversationId,
      senderPersonaId: turn.senderPersonaId,
      senderName: turn.senderName,
      content: turn.content.slice(0, 2000),
      source: 'agent',
      seq: i,
    });

    if (i % CONFIG.SIGNAL_UPDATE_EVERY === 0 || i === turns.length - 1) {
      const progress = (i + 1) / turns.length;
      const ramped = Math.round(result.signalStrength * progress);
      await conn.reducers.updateSignal({ conversationId, signalStrength: ramped });
    }

    await sleep(CONFIG.PACING_MS);
  }

  await conn.reducers.completeConversation({
    conversationId,
    rawScore: result.rawScore,
    signalStrength: result.signalStrength,
    reason: result.reason,
  });

  await conn.reducers.archiveConversation({
    sessionId,
    initiatorPersonaId: a.id,
    partnerPersonaId: b.id,
    personaSnapshot: jsonStringify({ a, b }),
    transcript: jsonStringify(turns.map((t) => ({ sender: t.senderName, text: t.content }))),
    rawScore: result.rawScore,
    signalStrength: result.signalStrength,
    reason: result.reason,
    model: result.model,
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
    saveToken(token);
    console.log('Orchestrator connected.');
    console.log('  Identity:', identity.toHexString());
    console.log('  Module  :', CONFIG.MODULE_NAME);

    conn
      .subscriptionBuilder()
      .onApplied((ctx: SubscriptionEventContext) => {
        console.log(
          `Subscription applied — ${[...ctx.db.persona.iter()].length} persona(s), ` +
            `${[...ctx.db.matchSession.iter()].length} session(s).`,
        );
        scanForWork(conn);
      })
      .onError((ctx: ErrorContext) => {
        console.error('Subscription error:', ctx.event);
      })
      .subscribe([
        'SELECT * FROM persona',
        'SELECT * FROM match_session',
        'SELECT * FROM conversation',
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

console.log(`Connecting to ${CONFIG.SPACETIMEDB_URI} (${CONFIG.MODULE_NAME})…`);
