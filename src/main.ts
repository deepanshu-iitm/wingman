/**
 * Wingman "Match Me" client (minimal demo UI).
 *
 * Renders purely from SpacetimeDB subscriptions:
 *   • create a persona,
 *   • click Match Me → startMatch reducer,
 *   • watch the live board (top conversations by signal + "chatting with N others"),
 *   • see the final top-3 match cards.
 *
 * All conversation generation happens in the orchestrator service; this client
 * never calls an LLM and holds no secrets.
 */

import { type Identity } from "spacetimedb";
import {
  DbConnection,
  type ErrorContext,
  type EventContext,
  type SubscriptionEventContext,
} from "./module_bindings/index.js";

// ── Config ──────────────────────────────────────────────────────────────────
const SPACETIMEDB_URI = "wss://maincloud.spacetimedb.com";
const MODULE_NAME =
  (import.meta as unknown as { env?: Record<string, string> }).env
    ?.VITE_MODULE_NAME ?? "wingman";
const TOP_N_SHOWN = 4;
const TOKEN_KEY = "wingman_token";

// ── State ───────────────────────────────────────────────────────────────────
let myIdentity: Identity | null = null;
let activeSessionId: bigint | null = null;
let watchForNewSession = false;
let conn: DbConnection;

// ── DOM ─────────────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusPill = $("conn-status");
const personaForm = $("persona-form") as HTMLFormElement;
const activeSelect = $("active-persona") as HTMLSelectElement;
const matchBtn = $("match-btn") as HTMLButtonElement;
const boardSection = $("board");
const boardMeta = $("board-meta");
const convosEl = $("convos");
const othersEl = $("others");
const resultsSection = $("results");
const resultCardsEl = $("result-cards");

const csv = (s: string): string[] =>
  s.split(",").map((x) => x.trim()).filter((x) => x.length > 0);

// ── Connect ─────────────────────────────────────────────────────────────────
const builder = DbConnection.builder()
  .withUri(SPACETIMEDB_URI)
  .withDatabaseName(MODULE_NAME)
  .onConnect((c: DbConnection, identity, token) => {
    conn = c;
    myIdentity = identity;
    localStorage.setItem(TOKEN_KEY, token);
    statusPill.textContent = "connected";
    statusPill.classList.add("on");

    c.subscriptionBuilder()
      .onApplied((_ctx: SubscriptionEventContext) => scheduleRender())
      .onError((ctx: ErrorContext) => console.error("Subscription error:", ctx.event))
      .subscribe([
        "SELECT * FROM persona",
        "SELECT * FROM match_session",
        "SELECT * FROM conversation",
        "SELECT * FROM message",
        "SELECT * FROM match_result",
      ]);

    // Re-render on any change to subscribed tables.
    const bump = () => scheduleRender();
    c.db.persona.onInsert(bump);
    c.db.conversation.onInsert(bump);
    c.db.conversation.onUpdate(bump);
    c.db.message.onInsert(bump);
    c.db.matchResult.onInsert(bump);
    c.db.matchSession.onInsert((_ctx: EventContext, row) => {
      if (watchForNewSession && myIdentity && row.owner.equals(myIdentity)) {
        activeSessionId = row.id;
        watchForNewSession = false;
      }
      scheduleRender();
    });
    c.db.matchSession.onUpdate(bump);
  })
  .onConnectError((_ctx: ErrorContext, error: Error) => {
    console.error("Connection error:", error);
    statusPill.textContent = "connection error";
  });

const savedToken = localStorage.getItem(TOKEN_KEY);
if (savedToken) builder.withToken(savedToken);
builder.build();

// ── Actions ─────────────────────────────────────────────────────────────────
personaForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!conn) return;
  conn.reducers.createPersona({
    displayName: ($("f-name") as HTMLInputElement).value.trim(),
    summary: ($("f-summary") as HTMLInputElement).value.trim(),
    interests: csv(($("f-interests") as HTMLInputElement).value),
    values: csv(($("f-values") as HTMLInputElement).value),
    socialStyle: ($("f-style") as HTMLInputElement).value.trim(),
  });
  personaForm.reset();
});

matchBtn.addEventListener("click", () => {
  if (!conn || !activeSelect.value) return;
  watchForNewSession = true;
  activeSessionId = null;
  resultsSection.classList.add("hidden");
  conn.reducers.startMatch({ personaId: BigInt(activeSelect.value) });
});

// ── Render ──────────────────────────────────────────────────────────────────
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function myPersonas() {
  const me = myIdentity;
  if (!conn || !me) return [];
  return [...conn.db.persona.iter()]
    .filter((p) => p.owner.equals(me))
    .sort((a, b) => Number(a.createdAt.microsSinceUnixEpoch - b.createdAt.microsSinceUnixEpoch));
}

function render() {
  if (!conn) return;

  // Persona dropdown (preserve current selection).
  const mine = myPersonas();
  const prev = activeSelect.value;
  activeSelect.innerHTML = "";
  for (const p of mine) {
    const opt = document.createElement("option");
    opt.value = p.id.toString();
    opt.textContent = p.displayName || `Persona ${p.id}`;
    activeSelect.appendChild(opt);
  }
  if (prev && mine.some((p) => p.id.toString() === prev)) activeSelect.value = prev;
  matchBtn.disabled = mine.length === 0;

  if (activeSessionId === null) {
    boardSection.classList.add("hidden");
    return;
  }

  const session = conn.db.matchSession.id.find(activeSessionId);
  if (!session) return;

  // Live board.
  boardSection.classList.remove("hidden");
  const convos = [...conn.db.conversation.iter()]
    .filter((c) => c.sessionId === activeSessionId)
    .sort((a, b) => b.signalStrength - a.signalStrength);

  const shown = convos.slice(0, TOP_N_SHOWN);
  const others = Number(session.totalConversations) - shown.length;

  const complete = convos.filter((c) => c.status === "complete").length;
  boardMeta.textContent =
    session.status === "complete"
      ? `Done — talked with ${convos.length} people.`
      : `Chatting live · ${complete}/${session.totalConversations} conversations wrapped`;

  convosEl.innerHTML = "";
  for (const convo of shown) {
    const msgs = [...conn.db.message.iter()]
      .filter((m) => m.conversationId === convo.id)
      .sort((a, b) => a.seq - b.seq);

    const card = document.createElement("div");
    card.className = "convo";
    const hot = convo.signalStrength >= 65 ? "hot" : "";
    card.innerHTML = `
      <div class="convo-head">
        <strong>${escapeHtml(convo.partnerDisplayName)}</strong>
        <span class="signal ${hot}">${convo.signalStrength}% signal</span>
      </div>
      <div class="bar"><span style="width:${convo.signalStrength}%"></span></div>
      <div class="msgs">
        ${msgs
          .map(
            (m) =>
              `<div class="msg"><span class="who">${escapeHtml(m.senderName)}:</span> ${escapeHtml(m.content)}</div>`,
          )
          .join("")}
      </div>`;
    convosEl.appendChild(card);
  }

  othersEl.textContent =
    others > 0 ? `…and chatting with ${others} other${others === 1 ? "" : "s"}.` : "";

  // Results.
  const results = [...conn.db.matchResult.iter()]
    .filter((r) => r.sessionId === activeSessionId)
    .sort((a, b) => a.rank - b.rank);

  if (results.length > 0) {
    resultsSection.classList.remove("hidden");
    const medals = ["🥇", "🥈", "🥉"];
    resultCardsEl.innerHTML = results
      .map(
        (r) => `
        <div class="result">
          <div class="rank">${medals[r.rank - 1] ?? `#${r.rank}`}</div>
          <div>
            <div class="who">${escapeHtml(r.partnerDisplayName)}</div>
            <div class="reason">${escapeHtml(r.reason)}</div>
          </div>
          <div class="score">${r.displayScore}%</div>
        </div>`,
      )
      .join("");
  } else {
    resultsSection.classList.add("hidden");
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
