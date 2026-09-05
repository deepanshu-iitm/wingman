/**
 * Wingman v2 client — an interview-first matchmaking SPA rendered entirely from
 * SpacetimeDB subscriptions.
 *
 * Flow (10 design screens → app views):
 *   signup → interview (voice/type → orchestrator persona draft) → read
 *   → room (agents working the room) → conversations (the live board)
 *   → match (it's mutual) → chat (human takes the wheel).
 *
 * The client never calls an LLM or holds secrets: persona extraction runs in the
 * orchestrator HTTP service, all conversation generation runs server-side, and
 * this file only reads subscribed tables and calls client-facing reducers.
 */

import { type Identity } from "spacetimedb";
import { CHARACTER_DEFS, characterFor, avatarSvg } from "./characters.js";
import {
  DbConnection,
  type ErrorContext,
  type EventContext,
  type SubscriptionEventContext,
} from "./module_bindings/index.js";

// ── Config ──────────────────────────────────────────────────────────────────
const clientEnv =
  (import.meta as unknown as { env?: Record<string, string> }).env ?? {};
const SPACETIMEDB_URI = "wss://maincloud.spacetimedb.com";
const MODULE_NAME = clientEnv.VITE_MODULE_NAME ?? "wingman";
const ORCHESTRATOR_URL = (
  clientEnv.VITE_ORCHESTRATOR_URL ?? "http://localhost:8787"
).replace(/\/+$/, "");
const TOKEN_KEY = "wingman_token";
const MAX_RECORDING_MS = 120_000;

// ── Types ───────────────────────────────────────────────────────────────────
type View =
  | "signup"
  | "interview"
  | "read"
  | "room"
  | "conversations"
  | "match"
  | "chat";

type PersonaDraft = {
  displayName: string;
  summary: string;
  interests: string[];
  values: string[];
  socialStyle: string;
};

type Conversation = ReturnType<DbConnection["db"]["conversation"]["iter"]> extends
  Iterable<infer R>
  ? R
  : never;

// ── App state ───────────────────────────────────────────────────────────────
let conn: DbConnection | null = null;
let myIdentity: Identity | null = null;

let view: View = "signup";
let activePersonaId: bigint | null = null;
let activeSessionId: bigint | null = null;
let watchForNewSession = false;
let watchForNewPersona = false;
let expandedId: bigint | null = null;
let matchSeen = false; // user has moved past the celebration into chat

// signup
const signup = { name: "", age: "", gender: "" };

// interview
let interviewMode: "voice" | "type" = "voice";
let recording = false;
let interviewBusy = false;
let interviewError = "";
let typeDraft = "";
let transcriptTurns: { who: "wingman" | "me"; text: string }[] = [
  {
    who: "wingman",
    text:
      "Tell me about yourself — what actually makes you click with someone?",
  },
];
let draft: PersonaDraft | null = null;

// per-conversation message drafts (takeover + post-match chat)
const inputDrafts: Record<string, string> = {};

// recorder plumbing
let recorder: MediaRecorder | null = null;
let microphoneStream: MediaStream | null = null;
let audioChunks: Blob[] = [];
let recordingTimer: ReturnType<typeof setTimeout> | undefined;

// ── DOM ─────────────────────────────────────────────────────────────────────
const app = document.getElementById("app") as HTMLDivElement;
const statusPill = document.getElementById("conn-status") as HTMLDivElement;
document.body.insertAdjacentHTML("afterbegin", CHARACTER_DEFS);

// ── Small helpers ─────────────────────────────────────────────────────────��─
const csv = (s: string): string[] =>
  s.split(",").map((x) => x.trim()).filter((x) => x.length > 0);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function avatar(seed: string | bigint, cls = "wg-av"): string {
  return `<div class="${cls}">${avatarSvg(characterFor(seed))}</div>`;
}

/** Qualitative signal state — a direction indicator, never a compatibility %. */
function signalState(s: number): { cls: string; label: string } {
  if (s >= 80) return { cls: "inseparable", label: "Inseparable" };
  if (s >= 55) return { cls: "clicking", label: "Clicking" };
  if (s >= 35) return { cls: "warming", label: "Warming up" };
  return { cls: "polite", label: "Polite" };
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

function couponFor(conversationId: bigint): string {
  return "WM-" + conversationId.toString(36).toUpperCase().padStart(4, "0").slice(-6);
}

const brand = `
  <div class="wg-brand">
    <div class="wg-brand-mark">W</div>
    <div class="wg-brand-name">Wingman</div>
    <div class="wg-brand-tag">your agent is in the room</div>
  </div>`;

// ── Backend selectors ─────────────────────────────────────────────────────��─
function myPersonas() {
  if (!conn) return [];
  return [...conn.db.myPersona.iter()].sort((a, b) =>
    Number(a.createdAt.microsSinceUnixEpoch - b.createdAt.microsSinceUnixEpoch),
  );
}

function activePersona() {
  if (!conn || activePersonaId === null) return null;
  return conn.db.myPersona.id.find(activePersonaId) ?? null;
}

function activeSession() {
  if (!conn || activeSessionId === null) return null;
  return conn.db.matchSession.id.find(activeSessionId) ?? null;
}

function sessionConvos(): Conversation[] {
  if (!conn || activeSessionId === null) return [];
  return [...conn.db.conversation.iter()]
    .filter((c) => c.sessionId === activeSessionId)
    .sort((a, b) => b.signalStrength - a.signalStrength);
}

function sessionResults() {
  if (!conn || activeSessionId === null) return [];
  return [...conn.db.matchResult.iter()]
    .filter((r) => r.sessionId === activeSessionId)
    .sort((a, b) => a.rank - b.rank);
}

function messagesFor(conversationId: bigint) {
  if (!conn) return [];
  return [...conn.db.message.iter()]
    .filter((m) => m.conversationId === conversationId)
    .sort((a, b) => a.seq - b.seq);
}

// ── Session/view derivation ──────────────────────────────────────────────────
/** After a reload, re-adopt this user's newest persona + session. */
function restoreState() {
  const me = myIdentity;
  if (!conn || !me) return;

  if (activePersonaId === null) {
    const mine = myPersonas();
    if (mine.length > 0) activePersonaId = mine[mine.length - 1].id;
  }

  if (activeSessionId === null && !watchForNewSession) {
    const mine = [...conn.db.matchSession.iter()]
      .filter((s) => s.owner.equals(me))
      .sort((a, b) =>
        Number(
          b.createdAt.microsSinceUnixEpoch - a.createdAt.microsSinceUnixEpoch,
        ),
      );
    if (mine.length > 0) {
      const live = mine.find((s) => s.status === "matching");
      const chosen = live ?? mine[0];
      activeSessionId = chosen.id;
      activePersonaId = chosen.initiatorPersonaId;
    }
  }
}

/** Nudge the view forward as backend state advances, without fighting the user. */
function autoAdvance() {
  const session = activeSession();
  const results = sessionResults();
  const convos = sessionConvos();

  // A finished match pulls the user to the celebration once, from the board.
  if (
    results.length > 0 &&
    !matchSeen &&
    (view === "room" || view === "conversations")
  ) {
    view = "match";
    return;
  }

  // Once conversations light up, leave the "working the room" holding screen.
  if (view === "room" && convos.length > 0) {
    view = "conversations";
    return;
  }

  // Nothing to show yet but a session exists → hold in the room.
  if (
    view === "room" &&
    session &&
    session.status !== "matching" &&
    convos.length === 0
  ) {
    view = "conversations";
  }
}

// ── Render scheduling ─────────────────────────────────────────────────────��─
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    restoreState();
    autoAdvance();
    render();
  });
}

function render() {
  // Preserve focus + caret across full-innerHTML swaps.
  const active = document.activeElement as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null;
  const focusKey = active?.dataset?.focus;
  const caret =
    active && "selectionStart" in active ? active.selectionStart : null;

  let html = "";
  switch (view) {
    case "signup":
      html = renderSignup();
      break;
    case "interview":
      html = renderInterview();
      break;
    case "read":
      html = renderRead();
      break;
    case "room":
      html = renderRoom();
      break;
    case "conversations":
      html = renderConversations();
      break;
    case "match":
      html = renderMatch();
      break;
    case "chat":
      html = renderChat();
      break;
  }
  app.innerHTML = html;

  if (focusKey) {
    const el = app.querySelector<HTMLInputElement>(
      `[data-focus="${focusKey}"]`,
    );
    if (el) {
      el.focus();
      if (caret != null) {
        try {
          el.setSelectionRange(caret, caret);
        } catch {
          /* number/etc. inputs disallow setSelectionRange */
        }
      }
    }
  }
}

// ── 01 · Signup ──────────────────────────────────────────────────────────────
function renderSignup(): string {
  const seed = signup.name || "you";
  const ready = signup.name.trim().length > 0;
  return `
  <div class="wg-screen">
    ${brand}
    <div class="wg-card wg-signup">
      <div class="wg-signup-form">
        <div>
          <div class="wg-eyebrow">First, the basics</div>
          <h1 class="wg-hero">Let's get you<br />in the room.</h1>
        </div>
        <div class="wg-field">
          <label class="wg-label" for="s-name">What should we call you?</label>
          <input class="wg-input" id="s-name" data-focus="s-name" data-field="name"
            placeholder="Your name" value="${escapeHtml(signup.name)}" maxlength="60" autocomplete="off" />
        </div>
        <div class="wg-field">
          <label class="wg-label">Age</label>
          <input class="wg-input" data-focus="s-age" data-field="age" inputmode="numeric"
            placeholder="e.g. 27" value="${escapeHtml(signup.age)}" maxlength="3" />
        </div>
        <div class="wg-field">
          <label class="wg-label">You are…</label>
          <div class="wg-seg">
            ${["Woman", "Man", "Nonbinary"]
              .map(
                (g) =>
                  `<button data-gender="${g}" class="${signup.gender === g ? "on" : ""}">${g}</button>`,
              )
              .join("")}
          </div>
        </div>
        <button class="wg-btn" data-action="to-interview" ${ready ? "" : "disabled"}>
          Start the interview <span class="sub">2 min</span>
        </button>
      </div>
      <div class="wg-signup-aside">
        <div class="wg-signup-avatar">${avatarSvg(characterFor(seed))}</div>
        <div>
          <div class="wg-h2">${escapeHtml(signup.name || "Hey there")}<span class="wg-caret"></span></div>
          <p class="wg-lead">Your Wingman does the mingling. You just show up for the ones worth meeting.</p>
        </div>
        <div class="wg-shuffle-row">
          ${["a", "s", "k", "m"]
            .map((c) => `<div class="wg-shuffle-chip">${avatarSvg(c as never)}</div>`)
            .join("")}
        </div>
      </div>
    </div>
  </div>`;
}

// ── 02 · Interview ───────────────────────────────────────────────────────────
function renderInterview(): string {
  const canCreate = draft !== null;
  const log = transcriptTurns
    .map(
      (t) => `
      <div class="wg-turn ${t.who === "me" ? "me" : ""}">
        <div class="who">${t.who === "me" ? "You" : "W"}</div>
        <div class="said">${escapeHtml(t.text)}</div>
      </div>`,
    )
    .join("");

  const draftBlock = draft
    ? `
      <div class="wg-turn">
        <div class="who">W</div>
        <div class="said">Here's what I heard — <strong>${escapeHtml(draft.summary)}</strong></div>
      </div>`
    : "";

  const micPanel =
    interviewMode === "voice"
      ? `
      <div class="wg-mic-panel">
        <div class="wg-mic-orb ${recording ? "live" : ""}" data-action="mic">${recording ? "◼" : "🎙"}</div>
        <div>
          <div class="wg-h2" style="color:var(--cream)">${recording ? "Listening…" : "Tap to talk"}</div>
          <p class="wg-lead" style="color:rgba(250,246,239,.6)">
            ${interviewBusy ? "Thinking about what you said…" : "Say it how you'd say it to a friend."}
          </p>
        </div>
        <button class="wg-btn-ghost wg-btn wg-btn-sm" style="color:var(--cream);border-color:var(--cream)"
          data-action="switch-type">Rather type it</button>
      </div>`
      : `
      <div class="wg-mic-panel" style="align-items:stretch">
        <div class="wg-h2" style="color:var(--cream)">Type it out</div>
        <textarea class="wg-input" data-focus="type" data-field="type"
          placeholder="What makes you click with someone? What are you into?">${escapeHtml(typeDraft)}</textarea>
        <button class="wg-btn wg-btn-green" data-action="submit-type" ${
          typeDraft.trim() && !interviewBusy ? "" : "disabled"
        }>${interviewBusy ? "Reading…" : "Hand it to Wingman"}</button>
        <button class="wg-btn-ghost wg-btn wg-btn-sm" style="color:var(--cream);border-color:var(--cream)"
          data-action="switch-voice">Use my voice instead</button>
      </div>`;

  return `
  <div class="wg-screen">
    ${brand}
    ${interviewError ? `<div class="wg-banner err">${escapeHtml(interviewError)}</div>` : ""}
    <div class="wg-interview">
      ${micPanel}
      <div class="wg-transcript">
        <div class="wg-eyebrow">The interview</div>
        <div class="wg-transcript-log">${log}${draftBlock}</div>
        ${
          canCreate
            ? `<button class="wg-btn" data-action="create-persona">Looks right — build my agent →</button>`
            : `<p class="wg-lead">Wingman turns this into an agent that goes and meets people for you.</p>`
        }
      </div>
    </div>
  </div>`;
}

// ── 03 · What it heard ───────────────────────────────────────────────────────
function renderRead(): string {
  const p = activePersona();
  if (!p) return renderLoading("Shaping your agent…");

  const traits = [
    { label: "Openness", v: 72 },
    { label: "Warmth", v: 64 },
    { label: "Wit", v: 81 },
    { label: "Depth", v: 58 },
  ];
  const nodes = [
    { label: "Curious", x: 26, y: 30 },
    { label: "Playful", x: 68, y: 24 },
    { label: "Grounded", x: 34, y: 72 },
    { label: "Ambitious", x: 74, y: 66 },
  ];

  return `
  <div class="wg-screen">
    ${brand}
    <div class="wg-read">
      <div class="wg-read-card">
        <div class="wg-read-avatar">${avatarSvg(characterFor(p.id))}</div>
        <div>
          <div class="wg-eyebrow">Your agent</div>
          <div class="wg-h2">${escapeHtml(p.displayName)}</div>
        </div>
        <p class="wg-quote">"${escapeHtml(p.summary)}"</p>
        <div>
          ${p.interests
            .map((i) => `<span class="wg-chip">${escapeHtml(i)}</span>`)
            .join("")}
        </div>
        <div>
          <div class="wg-label" style="margin-bottom:8px">What you value</div>
          ${p.values
            .map((v) => `<span class="wg-chip">${escapeHtml(v)}</span>`)
            .join("")}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:22px">
        <div class="wg-read-card">
          <div class="wg-eyebrow">Trait signature</div>
          ${traits
            .map(
              (t) => `
            <div class="wg-trait">
              <div style="display:flex;justify-content:space-between">
                <span style="font-weight:700">${t.label}</span>
                <span class="wg-lead">${t.v}</span>
              </div>
              <div class="wg-trait-bar"><span style="width:${t.v}%"></span></div>
            </div>`,
            )
            .join("")}
          <p class="wg-lead">Style read: <strong>${escapeHtml(p.socialStyle)}</strong></p>
        </div>
        <div class="wg-read-card">
          <div class="wg-eyebrow">Your mental model</div>
          <div class="wg-map">
            <div class="wg-map-axis" style="left:12px;top:8px">Head</div>
            <div class="wg-map-axis" style="right:12px;bottom:8px">Heart</div>
            ${nodes
              .map(
                (n) =>
                  `<div class="wg-map-node" style="left:${n.x}%;top:${n.y}%">${n.label}</div>`,
              )
              .join("")}
            <div class="wg-map-here" style="left:52%;top:48%"></div>
          </div>
        </div>
        <button class="wg-btn wg-btn-green" data-action="start-match">
          Send my agent in → <span class="sub">meet the room</span>
        </button>
      </div>
    </div>
  </div>`;
}

// ── 04 · Working the room ────────────────────────────────────────────────────
function renderRoom(): string {
  const session = activeSession();
  const convos = sessionConvos();
  const total = session ? Number(session.totalConversations) : convos.length;
  const worth = convos.filter((c) => c.signalStrength >= 35).length;

  const seeds =
    convos.length > 0
      ? convos.map((c) => c.partnerPersonaId)
      : conn
        ? [...conn.db.publicPersona.iter()].slice(0, 8).map((p) => p.id)
        : [];
  const orbiters = (seeds.length > 0 ? seeds : [1n, 2n, 3n, 4n, 5n, 6n]).slice(
    0,
    10,
  );

  const ring = (list: bigint[], radius: number) =>
    list
      .map((seed, i) => {
        const a = (i / list.length) * Math.PI * 2;
        const x = 50 + Math.cos(a) * radius;
        const y = 50 + Math.sin(a) * radius;
        return `<div class="wg-orbiter" style="left:${x}%;top:${y}%">${avatarSvg(
          characterFor(seed),
        )}</div>`;
      })
      .join("");

  const half = Math.ceil(orbiters.length / 2);
  return `
  <div class="wg-screen">
    <div class="wg-room">
      <div class="wg-scan"></div>
      <div class="wg-room-live"><span class="wg-dot"></span> your agent is mingling</div>
      <div class="wg-orbit">
        <div class="wg-orbit-ring">${ring(orbiters.slice(0, half), 46)}</div>
        <div class="wg-orbit-ring rev">${ring(orbiters.slice(half), 30)}</div>
      </div>
      <div class="wg-room-status">
        <div class="wg-h2" style="color:var(--cream)">Read ${total} mental model${total === 1 ? "" : "s"}</div>
        <div class="wg-room-step ${total > 0 ? "done" : "active"}">✓ scanning the room</div>
        <div class="wg-room-step ${convos.length > 0 ? "active" : ""}">◇ striking up conversations</div>
        <div class="wg-room-step ${worth > 0 ? "active" : ""}">
          ${worth > 0 ? `Found ${worth} worth talking to` : "◇ finding people worth your time"}
        </div>
        ${
          convos.length > 0
            ? `<button class="wg-btn wg-btn-green" data-action="to-conversations">See the conversations →</button>`
            : ""
        }
      </div>
    </div>
  </div>`;
}

// ── 05 · Three live conversations (the board) ────────────────────────────────
function renderConversations(): string {
  const session = activeSession();
  const convos = sessionConvos();
  const results = sessionResults();

  if (convos.length === 0) {
    return renderQuietRoom();
  }

  const shown = convos.slice(0, 3);
  const complete = convos.filter((c) => c.status === "complete").length;
  const total = session ? Number(session.totalConversations) : convos.length;
  const meta =
    session?.status === "complete"
      ? `Done — your agent talked with ${convos.length}.`
      : session?.status === "timed_out"
        ? `Time's up — ranked ${complete} finished chats.`
        : `Live · ${complete}/${total} conversations wrapping up`;

  const banner =
    results.length > 0
      ? `<div class="wg-banner info" style="justify-content:space-between">
           <span>💛 A match came through.</span>
           <button class="wg-btn wg-btn-coral wg-btn-sm" data-action="see-match">See it</button>
         </div>`
      : "";

  return `
  <div class="wg-screen">
    ${brand}
    ${banner}
    <div class="wg-convos-head">
      <div>
        <div class="wg-eyebrow">The room, live</div>
        <h1 class="wg-h2">Three conversations worth watching</h1>
      </div>
      <div class="wg-privacy">${escapeHtml(meta)}</div>
    </div>
    <div class="wg-convo-grid">
      ${shown.map(renderConvoCard).join("")}
    </div>
    <p class="wg-privacy" style="margin-top:16px">
      Only you can see your agent's conversations. The other side sees theirs.
    </p>
  </div>
  ${expandedId !== null ? renderOverlay() : ""}`;
}

function renderConvoCard(c: Conversation): string {
  const sig = signalState(c.signalStrength);
  const msgs = messagesFor(c.id).slice(-4);
  const total = c.turnCount || msgs.length;
  const controlledByMe =
    c.controlMode === "human" && c.humanPersonaId === activePersonaId;

  return `
    <div class="wg-convo">
      <div class="wg-convo-head">
        <div class="wg-av av">${avatarSvg(characterFor(c.partnerPersonaId))}</div>
        <div class="wg-convo-name">
          <div class="n">${escapeHtml(c.partnerDisplayName)}</div>
          <div class="t">turn ${msgs.length} of ${Math.max(total, msgs.length)}</div>
        </div>
        <span class="wg-signal ${sig.cls}">${sig.label}</span>
        <button class="wg-expand" data-action="expand" data-id="${c.id}">⤢</button>
      </div>
      <div class="wg-progress">
        <div class="wg-progress-track"><span style="width:${c.signalStrength}%"></span></div>
      </div>
      <div class="wg-msgs">
        ${msgs.map((m) => renderBubble(m, c)).join("")}
      </div>
      <div class="wg-convo-foot">
        ${
          c.status === "complete"
            ? `<span class="hint">Wrapped up.</span>`
            : controlledByMe
              ? `<span class="hint">You're at the wheel.</span>
                 <button class="wg-btn wg-btn-sm wg-btn-ghost" data-action="expand" data-id="${c.id}">Open</button>`
              : `<button class="wg-btn wg-btn-sm wg-btn-coral" data-action="takeover" data-id="${c.id}">Hand over to me</button>`
        }
      </div>
    </div>`;
}

function renderBubble(
  m: ReturnType<typeof messagesFor>[number],
  c: Conversation,
): string {
  const mine = m.senderPersonaId === c.initiatorPersonaId;
  const human = m.source === "human";
  const cls = human ? "human" : mine ? "mine" : "";
  const seed = mine ? c.initiatorPersonaId : c.partnerPersonaId;
  return `
    <div class="wg-bubble ${cls}">
      <div class="chip">${avatarSvg(characterFor(seed))}</div>
      <div class="text">${escapeHtml(m.content)}</div>
    </div>`;
}

// ── 06/07 · Expanded overlay + take the wheel ────────────────────────────────
function renderOverlay(): string {
  if (!conn || expandedId === null) return "";
  const c = conn.db.conversation.id.find(expandedId);
  if (!c) return "";
  const sig = signalState(c.signalStrength);
  const controlledByMe =
    c.controlMode === "human" && c.humanPersonaId === activePersonaId;
  const msgs = messagesFor(c.id);
  const states = ["Polite", "Warming", "Clicking", "Inseparable"];
  const activeIdx = ["polite", "warming", "clicking", "inseparable"].indexOf(
    sig.cls,
  );

  const foot = controlledByMe
    ? `<div class="wg-send-row">
         <input class="wg-input" data-focus="send-${c.id}" data-input="${c.id}"
           placeholder="Say something as you…" value="${escapeHtml(inputDrafts[c.id.toString()] ?? "")}" maxlength="2000" />
         <button class="wg-btn wg-btn-coral wg-btn-sm" data-action="send" data-id="${c.id}">Send</button>
         <button class="wg-btn wg-btn-ghost wg-btn-sm" data-action="release" data-id="${c.id}">Back to agent</button>
       </div>`
    : c.status === "complete"
      ? `<span class="hint">This conversation has wrapped.</span>`
      : `<button class="wg-btn wg-btn-coral" data-action="takeover" data-id="${c.id}">
           Take the wheel <span class="sub">jump in yourself</span>
         </button>`;

  return `
  <div class="wg-overlay" data-action="overlay-bg">
    <div class="wg-expanded ${controlledByMe ? "human" : ""}">
      <div class="wg-expanded-head">
        <div class="wg-av av">${avatarSvg(characterFor(c.partnerPersonaId))}</div>
        <div style="flex:1">
          <div style="font-size:19px;font-weight:800">${escapeHtml(c.partnerDisplayName)}</div>
          <div style="font-size:13px;opacity:.7">${controlledByMe ? "you're driving" : sig.label}</div>
        </div>
        <button class="wg-close" data-action="close-overlay">✕</button>
      </div>
      <div class="wg-scale">
        ${states
          .map((s, i) => `<span class="${i <= activeIdx ? "on" : ""}">${s}</span>`)
          .join("")}
      </div>
      <div class="wg-expanded-body">
        ${msgs.map((m) => renderBubble(m, c)).join("")}
      </div>
      <div class="wg-expanded-foot">${foot}</div>
    </div>
  </div>`;
}

// ── 08 · It's a match ────────────────────────────────────────────────────────
function renderMatch(): string {
  const results = sessionResults();
  const top = results[0];
  const p = activePersona();
  if (!top) return renderLoading("Counting the votes…");

  const confetti = Array.from({ length: 14 })
    .map((_, i) => {
      const colors = ["#FFB020", "#C9F24D", "#FAF6EF", "#7B4DFF"];
      const c = colors[i % colors.length];
      const left = (i * 7 + 4) % 100;
      const dur = 3 + (i % 5) * 0.6;
      const delay = (i % 7) * 0.4;
      return `<span class="wg-confetti" style="left:${left}%;background:${c};animation-duration:${dur}s;animation-delay:${delay}s"></span>`;
    })
    .join("");

  return `
  <div class="wg-match">
    ${confetti}
    <div class="wg-match-eyebrow"><span class="wg-dot"></span> it's mutual</div>
    <div class="wg-match-pair">
      <div class="p">${avatarSvg(characterFor(p?.id ?? "you"))}</div>
      <div class="p">${avatarSvg(characterFor(top.partnerPersonaId))}</div>
    </div>
    <div class="wg-match-title">It's a match.</div>
    <div class="wg-match-sub">You and ${escapeHtml(firstName(top.partnerDisplayName))} both said yes.</div>
    <div class="wg-match-quote">"${escapeHtml(top.reason)}"</div>
    <div class="wg-coupon">
      <span class="lead">First date's on us</span>
      <span class="div"></span>
      <span class="code">${couponFor(top.conversationId)}</span>
      <span class="fine">— show this at any partner café</span>
    </div>
    <div class="wg-match-actions">
      <button class="wg-btn wg-btn-green" data-action="to-chat" data-id="${top.conversationId}">
        Say hi to ${escapeHtml(firstName(top.partnerDisplayName))} →
      </button>
      <button class="wg-btn wg-btn-ghost" style="color:var(--cream);border-color:var(--cream)"
        data-action="back-to-board">See the other conversations</button>
    </div>
  </div>`;
}

// ── 09 · The chat ────────────────────────────────────────────────────────────
function renderChat(): string {
  const results = sessionResults();
  const top = results[0];
  if (!conn || !top) return renderLoading("Opening the chat…");
  const c = conn.db.conversation.id.find(top.conversationId);
  if (!c) return renderLoading("Opening the chat…");

  const msgs = messagesFor(c.id);
  return `
  <div class="wg-screen">
    <div class="wg-chat">
      <div class="wg-chat-head">
        <button class="wg-close" data-action="back-to-match">←</button>
        <div class="wg-av av" style="width:44px;height:44px">${avatarSvg(characterFor(c.partnerPersonaId))}</div>
        <div>
          <div style="font-size:19px;font-weight:800">${escapeHtml(c.partnerDisplayName)}</div>
          <div class="wg-privacy">you matched · say the first thing</div>
        </div>
      </div>
      <div class="wg-summary">
        <div class="wg-eyebrow">Why your agents clicked</div>
        <div class="wg-summary-body">${escapeHtml(top.reason)}</div>
      </div>
      <div class="wg-chat-log">
        ${msgs.map((m) => renderBubble(m, c)).join("")}
      </div>
      <div class="wg-send-row">
        <input class="wg-input" data-focus="chat-${c.id}" data-input="${c.id}"
          placeholder="Say hi…" value="${escapeHtml(inputDrafts[c.id.toString()] ?? "")}" maxlength="2000" />
        <button class="wg-btn wg-btn-coral" data-action="send" data-id="${c.id}">Send</button>
      </div>
    </div>
  </div>`;
}

// ── Edge states ──────────────────────────────────────────────────────────────
function renderLoading(text: string): string {
  return `
  <div class="wg-screen">
    ${brand}
    <div class="wg-card" style="text-align:center">
      <div class="wg-h2">${escapeHtml(text)}</div>
      <p class="wg-lead" style="margin-top:8px">One moment.</p>
    </div>
  </div>`;
}

function renderQuietRoom(): string {
  return `
  <div class="wg-screen">
    ${brand}
    <div class="wg-card" style="text-align:center;display:flex;flex-direction:column;gap:16px;align-items:center">
      <div style="font-size:52px">🫥</div>
      <div class="wg-h2">The room's quiet right now</div>
      <p class="wg-lead">Your agent is still looking for people worth your time. Hang tight — new conversations pop in live.</p>
      <button class="wg-btn wg-btn-ghost" data-action="to-room">Watch the room</button>
    </div>
  </div>`;
}

// ── Actions ──────────────────────────────────────────────────────────────────
async function handleAction(action: string, el: HTMLElement) {
  const idAttr = el.dataset.id;
  const convId = idAttr ? BigInt(idAttr) : null;

  switch (action) {
    case "to-interview":
      view = "interview";
      break;
    case "switch-type":
      interviewMode = "type";
      break;
    case "switch-voice":
      interviewMode = "voice";
      break;
    case "mic":
      toggleRecording();
      return;
    case "submit-type":
      void buildPersonaFromText(typeDraft);
      return;
    case "create-persona":
      createPersonaFromDraft();
      break;
    case "start-match":
      startMatch();
      break;
    case "to-conversations":
      view = "conversations";
      break;
    case "to-room":
      view = "room";
      break;
    case "expand":
      if (convId !== null) expandedId = convId;
      break;
    case "close-overlay":
    case "overlay-bg":
      // The click listener already guarantees overlay-bg is a true backdrop hit.
      expandedId = null;
      break;
    case "takeover":
      if (convId !== null) await takeover(convId);
      return;
    case "release":
      if (convId !== null) await release(convId);
      return;
    case "send":
      if (convId !== null) await sendInConversation(convId);
      return;
    case "see-match":
    case "see-match-top":
      view = "match";
      break;
    case "back-to-board":
      matchSeen = true;
      view = "conversations";
      break;
    case "to-chat":
      matchSeen = true;
      view = "chat";
      break;
    case "back-to-match":
      view = "match";
      break;
  }
  scheduleRender();
}

function createPersonaFromDraft() {
  if (!conn || !draft) return;
  const summary = signup.age || signup.gender
    ? `${draft.summary} (${[signup.age && `${signup.age}`, signup.gender]
        .filter(Boolean)
        .join(", ")}.)`
    : draft.summary;
  watchForNewPersona = true;
  conn.reducers.createPersona({
    displayName: draft.displayName || signup.name.trim(),
    summary,
    interests: draft.interests,
    values: draft.values,
    socialStyle: draft.socialStyle,
  });
}

function startMatch() {
  if (!conn || activePersonaId === null) return;
  watchForNewSession = true;
  activeSessionId = null;
  matchSeen = false;
  view = "room";
  conn.reducers.startMatch({ personaId: activePersonaId });
}

async function takeover(conversationId: bigint) {
  if (!conn || activePersonaId === null) return;
  try {
    await conn.reducers.takeOverConversation({
      conversationId,
      personaId: activePersonaId,
    });
    expandedId = conversationId;
  } catch (e) {
    console.error("takeover failed", e);
  }
  scheduleRender();
}

async function release(conversationId: bigint) {
  if (!conn || activePersonaId === null) return;
  try {
    await conn.reducers.releaseConversation({
      conversationId,
      personaId: activePersonaId,
    });
  } catch (e) {
    console.error("release failed", e);
  }
  scheduleRender();
}

async function sendInConversation(conversationId: bigint) {
  if (!conn || activePersonaId === null) return;
  const convo = conn.db.conversation.id.find(conversationId);
  if (!convo) return;
  const key = conversationId.toString();
  const content = (inputDrafts[key] ?? "").trim();
  if (!content) return;
  try {
    // sendHumanMessage requires human control — take the wheel first if needed.
    if (
      convo.controlMode !== "human" ||
      convo.humanPersonaId !== activePersonaId
    ) {
      await conn.reducers.takeOverConversation({
        conversationId,
        personaId: activePersonaId,
      });
    }
    await conn.reducers.sendHumanMessage({
      conversationId,
      personaId: activePersonaId,
      content,
    });
    inputDrafts[key] = "";
  } catch (e) {
    console.error("send failed", e);
  }
  scheduleRender();
}

// ── Event wiring ─────────────────────────────────────────────────────────────
app.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!el) return;
  // Overlay background should only close on a direct backdrop click.
  if (el.dataset.action === "overlay-bg" && e.target !== el) return;
  void handleAction(el.dataset.action!, el);
});

app.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement | HTMLTextAreaElement;
  if (t.dataset.field === "name") {
    signup.name = t.value;
    // Live-update the aside name/avatar without stealing caret.
    const h = app.querySelector(".wg-signup-aside .wg-h2");
    if (h) h.firstChild!.textContent = t.value || "Hey there";
  } else if (t.dataset.field === "age") {
    signup.age = t.value.replace(/\D/g, "");
  } else if (t.dataset.field === "type") {
    typeDraft = t.value;
  } else if (t.dataset.input) {
    inputDrafts[t.dataset.input] = t.value;
  }
});

app.addEventListener("keydown", (e) => {
  const t = e.target as HTMLInputElement;
  if (e.key === "Enter" && t.dataset?.input) {
    e.preventDefault();
    void sendInConversation(BigInt(t.dataset.input));
  }
});

// Gender segmented control needs a fresh render to move the highlight.
app.addEventListener("click", (e) => {
  const g = (e.target as HTMLElement).closest<HTMLElement>("[data-gender]");
  if (!g) return;
  signup.gender = g.dataset.gender!;
  render();
});

// ── Voice recording ──────────────────────────────────────────────────────────
function releaseMicrophone() {
  clearTimeout(recordingTimer);
  recordingTimer = undefined;
  microphoneStream?.getTracks().forEach((t) => t.stop());
  microphoneStream = null;
  recorder = null;
  recording = false;
}

function toggleRecording() {
  if (recording) {
    if (recorder?.state === "recording") recorder.stop();
    return;
  }
  void startRecording();
}

async function startRecording() {
  interviewError = "";
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    interviewError =
      "Voice recording isn't available in this browser — type it instead.";
    interviewMode = "type";
    scheduleRender();
    return;
  }
  const supportedType = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ].find((type) => MediaRecorder.isTypeSupported(type));

  try {
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });
    audioChunks = [];
    recorder = new MediaRecorder(
      microphoneStream,
      supportedType ? { mimeType: supportedType } : undefined,
    );
    recorder.addEventListener("dataavailable", (ev) => {
      if (ev.data.size > 0) audioChunks.push(ev.data);
    });
    recorder.addEventListener("stop", () => {
      const mimeType = recorder?.mimeType || "application/octet-stream";
      const chunks = audioChunks;
      releaseMicrophone();
      scheduleRender();
      if (chunks.length === 0) {
        interviewError = "No audio captured — try again.";
        scheduleRender();
        return;
      }
      void buildPersonaFromRecording(new Blob(chunks, { type: mimeType }));
    });
    recorder.start();
    recording = true;
    recordingTimer = setTimeout(() => {
      if (recorder?.state === "recording") recorder.stop();
    }, MAX_RECORDING_MS);
    scheduleRender();
  } catch {
    releaseMicrophone();
    interviewError =
      "Microphone blocked. Allow access and retry, or type it instead.";
    scheduleRender();
  }
}

async function readApiResponse<T>(
  response: Response,
  fallback: string,
): Promise<T> {
  let result: { error?: unknown } & Partial<T>;
  try {
    result = (await response.json()) as { error?: unknown } & Partial<T>;
  } catch {
    throw new Error(fallback);
  }
  if (!response.ok) {
    throw new Error(typeof result.error === "string" ? result.error : fallback);
  }
  return result as T;
}

async function buildPersonaFromRecording(audio: Blob) {
  interviewBusy = true;
  interviewError = "";
  scheduleRender();
  try {
    const res = await fetch(`${ORCHESTRATOR_URL}/api/transcribe?language=en`, {
      method: "POST",
      headers: { "Content-Type": audio.type || "application/octet-stream" },
      body: audio,
    });
    const { transcript } = await readApiResponse<{ transcript: string }>(
      res,
      "Transcription failed. Please try again.",
    );
    transcriptTurns.push({ who: "me", text: transcript });
    await extractPersona(transcript);
  } catch (e) {
    interviewError =
      e instanceof Error ? e.message : "Voice onboarding failed.";
  } finally {
    interviewBusy = false;
    scheduleRender();
  }
}

async function buildPersonaFromText(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return;
  interviewBusy = true;
  interviewError = "";
  transcriptTurns.push({ who: "me", text: trimmed });
  scheduleRender();
  try {
    await extractPersona(trimmed);
    typeDraft = "";
  } catch (e) {
    interviewError =
      e instanceof Error ? e.message : "Couldn't read that. Try again.";
  } finally {
    interviewBusy = false;
    scheduleRender();
  }
}

async function extractPersona(transcript: string) {
  const res = await fetch(`${ORCHESTRATOR_URL}/api/persona`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: signup.name.trim(), transcript }),
  });
  const { persona } = await readApiResponse<{ persona: PersonaDraft }>(
    res,
    "Persona extraction failed. Please try again.",
  );
  draft = {
    displayName: persona.displayName || signup.name.trim(),
    summary: persona.summary,
    interests: persona.interests ?? [],
    values: persona.values ?? [],
    socialStyle: persona.socialStyle ?? "",
  };
}

// ── Connect ──────────────────────────────────────────────────────────────────
function setConn(state: "connecting" | "on" | "err", text: string) {
  statusPill.textContent = text;
  statusPill.classList.toggle("on", state === "on");
  statusPill.classList.toggle("err", state === "err");
}

const builder = DbConnection.builder()
  .withUri(SPACETIMEDB_URI)
  .withDatabaseName(MODULE_NAME)
  .onConnect((c: DbConnection, identity, token) => {
    conn = c;
    myIdentity = identity;
    localStorage.setItem(TOKEN_KEY, token);
    setConn("on", "connected");

    c.subscriptionBuilder()
      .onApplied((_ctx: SubscriptionEventContext) => {
        restoreState();
        // Land on the right screen after a reload.
        if (activeSessionId !== null) {
          const results = sessionResults();
          if (results.length > 0) view = matchSeen ? "chat" : "match";
          else if (sessionConvos().length > 0) view = "conversations";
          else view = "room";
        } else if (activePersonaId !== null) {
          view = "read";
        }
        scheduleRender();
      })
      .onError((ctx: ErrorContext) => console.error("Subscription error:", ctx.event))
      // Server-side clientVisibilityFilter exports enforce participant-only
      // access; SELECT * is safe — unauthorised rows never reach this client.
      .subscribe([
        "SELECT * FROM my_persona",
        "SELECT * FROM public_persona",
        "SELECT * FROM match_session",
        "SELECT * FROM conversation",
        "SELECT * FROM message",
        "SELECT * FROM match_result",
      ]);

    const bump = () => scheduleRender();
    c.db.publicPersona.onInsert(bump);
    c.db.conversation.onInsert(bump);
    c.db.conversation.onUpdate(bump);
    c.db.message.onInsert(bump);
    c.db.matchResult.onInsert(bump);
    c.db.matchSession.onUpdate(bump);

    c.db.myPersona.onInsert((_ctx: EventContext, row) => {
      if (watchForNewPersona && myIdentity && row.owner.equals(myIdentity)) {
        activePersonaId = row.id;
        watchForNewPersona = false;
        view = "read";
      }
      scheduleRender();
    });
    c.db.matchSession.onInsert((_ctx: EventContext, row) => {
      if (watchForNewSession && myIdentity && row.owner.equals(myIdentity)) {
        activeSessionId = row.id;
        activePersonaId = row.initiatorPersonaId;
        watchForNewSession = false;
      }
      scheduleRender();
    });
  })
  .onConnectError((_ctx: ErrorContext, error: Error) => {
    console.error("Connection error:", error);
    setConn("err", "connection error");
  })
  .onDisconnect(() => setConn("err", "reconnecting…"));

const savedToken = localStorage.getItem(TOKEN_KEY);
if (savedToken) builder.withToken(savedToken);
builder.build();

// First paint before the socket settles.
render();
