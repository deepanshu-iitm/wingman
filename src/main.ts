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
const MAX_INTERVIEW_MS = 5 * 60_000;
const INTERVIEW_SAMPLE_RATE = 16_000;

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
  voiceStyle: string; // how they talk, so their agent speaks in their voice
  speechSample: string; // short verbatim excerpt from the interview
};

type Conversation = ReturnType<DbConnection["db"]["conversation"]["iter"]> extends
  Iterable<infer R>
  ? R
  : never;

type Persona = NonNullable<ReturnType<typeof activePersona>>;

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

// `matchSeen` must survive reloads, or onApplied re-shows the celebration on
// top of the chat the user already moved on to. Persist it per session id.
const seenKey = (sessionId: bigint) => `wingman_match_seen_${sessionId}`;
function markMatchSeen() {
  matchSeen = true;
  if (activeSessionId !== null) {
    try {
      localStorage.setItem(seenKey(activeSessionId), "1");
    } catch {
      /* storage unavailable — degrade to in-memory only */
    }
  }
}
function loadMatchSeen(sessionId: bigint): boolean {
  try {
    return localStorage.getItem(seenKey(sessionId)) === "1";
  } catch {
    return false;
  }
}

// signup
const signup = { name: "", email: "", age: "", gender: "" };
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let welcomeEmailRequested = false;

// interview
let interviewMode: "voice" | "type" = "voice";
let recording = false;
let interviewBusy = false;
let interviewError = "";
let voiceConsent = false;
let liveTranscript = "";
let typeDraft = "";
let transcriptTurns: { who: "wingman" | "me"; text: string }[] = [
  {
    who: "wingman",
    text:
      "Tell me about yourself — what actually makes you click with someone?",
  },
];
let draft: PersonaDraft | null = null;
let onboardingSubmitted = false;
let thankYouVisible = false;

// per-conversation message drafts (takeover + post-match chat)
const inputDrafts: Record<string, string> = {};

// live interview audio plumbing
let interviewSocket: WebSocket | null = null;
let microphoneStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let audioProcessor: ScriptProcessorNode | null = null;
let captureEnabled = false;
let interviewTimer: ReturnType<typeof setTimeout> | undefined;
let speechPlayback: Promise<void> | null = null;
let personaPending = false;

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
  const ready =
    signup.name.trim().length > 0 && EMAIL_PATTERN.test(signup.email.trim());
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
          <label class="wg-label" for="s-email">Where should we send your welcome?</label>
          <input class="wg-input" id="s-email" data-focus="s-email" data-field="email"
            type="email" inputmode="email" placeholder="you@example.com"
            value="${escapeHtml(signup.email)}" maxlength="254" autocomplete="email" />
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
  const log = transcriptTurns
    .map(
      (t) => `
      <div class="wg-turn ${t.who === "me" ? "me" : ""}">
        <div class="who">${t.who === "me" ? "You" : "W"}</div>
        <div class="said">${escapeHtml(t.text)}</div>
      </div>`,
    )
    .join("");
  const partialTurn = liveTranscript
    ? `
      <div class="wg-turn me wg-turn-partial">
        <div class="who">You</div>
        <div class="said">${escapeHtml(liveTranscript)}</div>
      </div>`
    : "";

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
        <button class="wg-mic-orb ${recording ? "live" : ""}" data-action="mic"
          ${!voiceConsent && !recording ? "disabled" : ""}>${recording ? "✓" : "🎙"}</button>
        <div>
          <div class="wg-h2" style="color:var(--cream)">${
            captureEnabled
              ? "Listening…"
              : recording
                ? "Wingman is responding…"
                : "Start voice interview"
          }</div>
          <p class="wg-lead" style="color:rgba(250,246,239,.6)">
            ${
              interviewBusy
                ? "Thinking about what you said…"
                : recording
                  ? "Tap ✓ when you have shared enough."
                  : "Wingman asks aloud. Answer naturally, then pause for three seconds."
            }
          </p>
        </div>
        <label class="wg-consent">
          <input type="checkbox" data-field="voice-consent" ${voiceConsent ? "checked" : ""} />
          I consent to live transcription and storing a short speech excerpt to shape my agent's
          writing style. Raw audio is not stored.
        </label>
        <button class="wg-btn-ghost wg-btn wg-btn-sm" style="color:var(--cream);border-color:var(--cream)"
          data-action="switch-type" ${recording ? "disabled" : ""}>Rather type it</button>
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
        <div class="wg-transcript-log">${log}${partialTurn}${draftBlock}</div>
        ${
          onboardingSubmitted
            ? `<div class="wg-banner">Your Wingman profile is ready. We’ll be in touch soon.</div>`
            : draft
              ? `<p class="wg-lead">Finishing your Wingman profile…</p>`
            : `<p class="wg-lead">Wingman turns this into an agent that goes and meets people for you.</p>`
        }
      </div>
    </div>
    ${thankYouVisible ? renderThankYou() : ""}
  </div>`;
}

function renderThankYou(): string {
  return `
    <div class="wg-overlay">
      <section class="wg-thankyou" role="dialog" aria-modal="true" aria-labelledby="thankyou-title">
        <div class="wg-thankyou-mark">W</div>
        <div class="wg-eyebrow">You’re all set</div>
        <h2 class="wg-hero" id="thankyou-title">Thank you, ${escapeHtml(signup.name)}.</h2>
        <p class="wg-lead">
          Your Wingman is ready and learning what makes a connection feel right for you.
          We’re thoughtfully preparing the next step and will get back to you soon when
          there’s someone worth meeting.
        </p>
        <p class="wg-thankyou-note">Until then, your Wingman has it from here.</p>
        <button class="wg-btn" data-action="dismiss-thankyou">Got it</button>
      </section>
    </div>`;
}

// ── 03 · What it heard ───────────────────────────────────────────────────────
/** Stable string hash (matches characters.ts) for deterministic projections. */
function strHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Map a hash into an inclusive numeric range, deterministically. */
function inRange(seed: string, lo: number, hi: number): number {
  return lo + (strHash(seed) % (hi - lo + 1));
}

/**
 * Trait signature and mental-model nodes are a deterministic *client-side
 * projection* of the persona's real fields (not a backend-computed embedding —
 * see PR #7 review, @RameshKumarS48). They stay stable per persona and shift
 * with the actual interests / values / style the interview produced.
 */
function deriveTraits(p: Persona): { label: string; v: number }[] {
  const clamp = (n: number) => Math.max(40, Math.min(93, n));
  const nI = p.interests.length;
  const nV = p.values.length;
  return [
    { label: "Openness", v: clamp(56 + nI * 5 + (strHash(p.id + "open") % 14)) },
    { label: "Warmth", v: clamp(52 + nV * 6 + (strHash(p.id + "warm") % 12)) },
    { label: "Wit", v: clamp(50 + (strHash(p.socialStyle + "wit") % 40)) },
    { label: "Depth", v: clamp(48 + Math.min(24, Math.floor(p.summary.length / 12)) + (strHash(p.id + "depth") % 10)) },
  ];
}

function deriveNodes(p: Persona): { label: string; x: number; y: number }[] {
  const labels = (p.interests.length ? p.interests : p.values).slice(0, 4);
  if (!labels.length) labels.push(p.socialStyle || "You");
  return labels.map((label) => ({
    label,
    x: inRange(label + "x", 16, 84),
    y: inRange(label + "y", 16, 84),
  }));
}

function renderRead(): string {
  const p = activePersona();
  if (!p) return renderLoading("Shaping your agent…");

  const traits = deriveTraits(p);
  const nodes = deriveNodes(p);
  // "here" marker sits at the centroid of the plotted nodes.
  const hereX = Math.round(nodes.reduce((s, n) => s + n.x, 0) / nodes.length);
  const hereY = Math.round(nodes.reduce((s, n) => s + n.y, 0) / nodes.length);

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
            <div class="wg-map-here" style="left:${hereX}%;top:${hereY}%"></div>
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
  const allMsgs = messagesFor(c.id);
  const msgs = allMsgs.slice(-4); // only the last few are rendered in the card
  const done = allMsgs.length; // full progress, independent of what's shown
  const total = Math.max(c.turnCount, done);
  const controlledByMe =
    c.controlMode === "human" && c.humanPersonaId === activePersonaId;

  return `
    <div class="wg-convo">
      <div class="wg-convo-head">
        <div class="wg-av av">${avatarSvg(characterFor(c.partnerPersonaId))}</div>
        <div class="wg-convo-name">
          <div class="n">${escapeHtml(c.partnerDisplayName)}</div>
          <div class="t">turn ${done} of ${total}</div>
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
      await createPersonaFromDraft();
      break;
    case "dismiss-thankyou":
      thankYouVisible = false;
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
      markMatchSeen();
      view = "conversations";
      break;
    case "to-chat":
      markMatchSeen();
      view = "chat";
      break;
    case "back-to-match":
      view = "match";
      break;
  }
  scheduleRender();
}

async function createPersonaFromDraft() {
  if (!conn || !draft || onboardingSubmitted) return;
  const summary = signup.age || signup.gender
    ? `${draft.summary} (${[signup.age && `${signup.age}`, signup.gender]
        .filter(Boolean)
        .join(", ")}.)`
    : draft.summary;
  onboardingSubmitted = true;
  thankYouVisible = true;
  watchForNewPersona = true;
  scheduleRender();

  try {
    await conn.reducers.createPersona({
      displayName: draft.displayName || signup.name.trim(),
      summary,
      interests: draft.interests,
      values: draft.values,
      socialStyle: draft.socialStyle,
      voiceStyle: draft.voiceStyle,
      speechSample: draft.speechSample,
    });
  } catch (error) {
    onboardingSubmitted = false;
    thankYouVisible = false;
    watchForNewPersona = false;
    interviewError =
      error instanceof Error ? error.message : "Couldn’t save your Wingman profile.";
    scheduleRender();
    return;
  }

  if (!welcomeEmailRequested) {
    welcomeEmailRequested = true;
    try {
      const response = await fetch(`${ORCHESTRATOR_URL}/api/welcome`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: signup.email.trim(),
          displayName: signup.name.trim(),
        }),
      });
      if (!response.ok) throw new Error(`Welcome email failed (${response.status})`);
    } catch (error) {
      welcomeEmailRequested = false;
      console.warn("Welcome email could not be sent.", error);
    }
  }
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
    if (convo.status === "complete") {
      // Post-match chat (screen 09): the winning conversation is already
      // 'complete', which takeOver/sendHuman reject. sendMatchMessage appends
      // on top of the settled match without reopening it.
      await conn.reducers.sendMatchMessage({
        conversationId,
        personaId: activePersonaId,
        content,
      });
    } else {
      // Live takeover (overlay): sendHumanMessage needs human control first.
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
    }
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
  } else if (t.dataset.field === "email") {
    signup.email = t.value;
  } else if (t.dataset.field === "age") {
    signup.age = t.value.replace(/\D/g, "");
  } else if (
    t.dataset.field === "voice-consent" &&
    t instanceof HTMLInputElement
  ) {
    voiceConsent = t.checked;
    scheduleRender();
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

// ── Live voice interview ─────────────────────────────────────────────────────
async function releaseMicrophone() {
  clearTimeout(interviewTimer);
  interviewTimer = undefined;
  captureEnabled = false;
  audioProcessor?.disconnect();
  audioProcessor = null;
  microphoneStream?.getTracks().forEach((track) => track.stop());
  microphoneStream = null;
  recording = false;
  const context = audioContext;
  audioContext = null;
  if (context && context.state !== "closed") await context.close();
}

function pcm16Buffer(samples: Float32Array): ArrayBuffer {
  const output = new ArrayBuffer(samples.length * 2);
  const view = new DataView(output);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(
      index * 2,
      sample < 0 ? sample * 0x8000 : sample * 0x7fff,
      true,
    );
  }
  return output;
}

function resampleTo16Khz(
  samples: Float32Array,
  inputSampleRate: number,
): Float32Array {
  if (inputSampleRate === INTERVIEW_SAMPLE_RATE) return samples;
  const ratio = inputSampleRate / INTERVIEW_SAMPLE_RATE;
  const output = new Float32Array(Math.round(samples.length / ratio));
  for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
    const start = Math.floor(outputIndex * ratio);
    const end = Math.min(
      samples.length,
      Math.floor((outputIndex + 1) * ratio),
    );
    let sum = 0;
    for (let inputIndex = start; inputIndex < end; inputIndex += 1) {
      sum += samples[inputIndex] ?? 0;
    }
    output[outputIndex] = sum / Math.max(1, end - start);
  }
  return output;
}

function audioBufferFromBase64(audioBase64: string): ArrayBuffer {
  return Uint8Array.from(atob(audioBase64), (character) =>
    character.charCodeAt(0),
  ).buffer;
}

async function playAgentSpeech(audioBase64: string): Promise<void> {
  if (!audioContext) throw new Error("Audio context is unavailable");
  captureEnabled = false;
  const decoded = await audioContext.decodeAudioData(
    audioBufferFromBase64(audioBase64),
  );
  const source = audioContext.createBufferSource();
  source.buffer = decoded;
  source.connect(audioContext.destination);
  await new Promise<void>((resolve) => {
    source.addEventListener("ended", () => resolve(), { once: true });
    source.start();
  });
}

type InterviewMessage = {
  type?: string;
  state?: string;
  text?: string;
  reply?: string;
  question?: string;
  error?: string;
  audioBase64?: string;
  persona?: PersonaDraft;
};

function armAnswerCapture() {
  if (interviewSocket?.readyState !== WebSocket.OPEN) return;
  interviewSocket.send(JSON.stringify({ type: "ready_for_answer" }));
  captureEnabled = true;
  interviewBusy = false;
}

function handleInterviewMessage(message: InterviewMessage) {
  if (message.type === "ready" && message.question) {
    transcriptTurns = [{ who: "wingman", text: message.question }];
    interviewBusy = true;
  } else if (message.type === "transcript.partial" && message.text) {
    liveTranscript = message.text;
    interviewBusy = false;
  } else if (message.type === "transcript.final" && message.text) {
    transcriptTurns.push({ who: "me", text: message.text });
    liveTranscript = "";
    captureEnabled = false;
    interviewBusy = true;
  } else if (message.type === "question" && message.question) {
    transcriptTurns.push({
      who: "wingman",
      text: `${message.reply ?? ""} ${message.question}`.trim(),
    });
    captureEnabled = false;
    interviewBusy = true;
  } else if (message.type === "reply" && message.text) {
    transcriptTurns.push({ who: "wingman", text: message.text });
    captureEnabled = false;
    interviewBusy = true;
  } else if (message.type === "speech" && message.audioBase64) {
    const playback = playAgentSpeech(message.audioBase64);
    speechPlayback = playback;
    void playback
      .then(() => {
        if (
          interviewSocket?.readyState === WebSocket.OPEN &&
          !draft &&
          !personaPending
        ) {
          armAnswerCapture();
          scheduleRender();
        }
      })
      .catch(() => {
        armAnswerCapture();
        interviewError =
          "Voice playback failed — answer the question shown on screen.";
        scheduleRender();
      })
      .finally(() => {
        if (speechPlayback === playback) speechPlayback = null;
      });
  } else if (message.type === "speech.unavailable") {
    armAnswerCapture();
    interviewError =
      "Voice playback is unavailable — answer the question shown on screen.";
  } else if (message.type === "finish.rejected") {
    armAnswerCapture();
    interviewError = message.error ?? "Answer a question before finishing.";
  } else if (message.type === "status") {
    interviewBusy = [
      "thinking",
      "generating_speech",
      "creating_persona",
    ].includes(message.state ?? "");
  } else if (message.type === "persona" && message.persona) {
    personaPending = true;
    const persona = message.persona;
    void (async () => {
      try {
        await speechPlayback;
      } catch {
        // The text response remains visible when audio playback fails.
      }
      draft = {
        ...persona,
        displayName: persona.displayName || signup.name.trim(),
      };
      personaPending = false;
      interviewBusy = false;
      await releaseMicrophone();
      interviewSocket?.close();
      interviewSocket = null;
      await createPersonaFromDraft();
    })();
  } else if (message.type === "error") {
    interviewBusy = false;
    interviewError =
      message.error ?? "Voice interview failed. Please try again.";
  }
  scheduleRender();
}

function toggleRecording() {
  if (recording) {
    if (interviewSocket?.readyState !== WebSocket.OPEN) return;
    captureEnabled = false;
    interviewBusy = true;
    interviewSocket.send(JSON.stringify({ type: "finish" }));
    scheduleRender();
    return;
  }
  void startVoiceInterview();
}

async function startVoiceInterview() {
  interviewError = "";
  liveTranscript = "";
  personaPending = false;
  if (!voiceConsent) {
    interviewError = "Confirm voice processing consent before starting.";
    scheduleRender();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
    interviewError =
      "Live voice isn't available in this browser — type it instead.";
    interviewMode = "type";
    scheduleRender();
    return;
  }

  try {
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    audioContext = new AudioContext({ sampleRate: INTERVIEW_SAMPLE_RATE });
    await audioContext.resume();

    const source = audioContext.createMediaStreamSource(microphoneStream);
    // 2,048 PCM16 samples produce Smallest's recommended 4,096-byte frames.
    audioProcessor = audioContext.createScriptProcessor(2048, 1, 1);
    const silentOutput = audioContext.createGain();
    silentOutput.gain.value = 0;
    source.connect(audioProcessor);
    audioProcessor.connect(silentOutput);
    silentOutput.connect(audioContext.destination);

    const socketUrl = new URL(
      ORCHESTRATOR_URL.replace(/^http/, "ws") + "/api/interview/stream",
    );
    socketUrl.searchParams.set("displayName", signup.name.trim());
    socketUrl.searchParams.set("language", "en");
    interviewSocket = new WebSocket(socketUrl);

    audioProcessor.addEventListener("audioprocess", (event) => {
      if (
        !captureEnabled ||
        interviewSocket?.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      const samples = resampleTo16Khz(
        event.inputBuffer.getChannelData(0),
        event.inputBuffer.sampleRate,
      );
      interviewSocket.send(pcm16Buffer(samples));
    });
    interviewSocket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      try {
        handleInterviewMessage(JSON.parse(event.data) as InterviewMessage);
      } catch {
        interviewError = "Wingman sent an invalid interview response.";
        scheduleRender();
      }
    });
    interviewSocket.addEventListener("error", () => {
      interviewError = "Could not connect to the live voice interview.";
      interviewBusy = false;
      void releaseMicrophone();
      scheduleRender();
    });
    interviewSocket.addEventListener("close", () => {
      if (!recording) return;
      void releaseMicrophone();
      if (!draft && !interviewError) {
        interviewError = "The live voice interview disconnected.";
      }
      scheduleRender();
    });

    recording = true;
    interviewBusy = true;
    interviewTimer = setTimeout(() => {
      if (interviewSocket?.readyState === WebSocket.OPEN) {
        captureEnabled = false;
        interviewSocket.send(JSON.stringify({ type: "finish" }));
      }
    }, MAX_INTERVIEW_MS);
    scheduleRender();
  } catch {
    await releaseMicrophone();
    interviewSocket?.close();
    interviewSocket = null;
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
    voiceStyle: persona.voiceStyle ?? "",
    speechSample: persona.speechSample ?? "",
  };
  await createPersonaFromDraft();
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
          matchSeen = loadMatchSeen(activeSessionId);
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
