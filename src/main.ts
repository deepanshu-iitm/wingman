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
const clientEnv =
  (import.meta as unknown as { env?: Record<string, string> }).env ?? {};
const SPACETIMEDB_URI = "wss://maincloud.spacetimedb.com";
const MODULE_NAME = clientEnv.VITE_MODULE_NAME ?? "wingman";
const ORCHESTRATOR_URL = (
  clientEnv.VITE_ORCHESTRATOR_URL ?? "http://localhost:8787"
).replace(/\/+$/, "");
const TOP_N_SHOWN = 4;
const TOKEN_KEY = "wingman_token";
const MAX_INTERVIEW_MS = 5 * 60_000;
const INTERVIEW_SAMPLE_RATE = 16_000;

// ── State ───────────────────────────────────────────────────────────────────
let myIdentity: Identity | null = null;
let activeSessionId: bigint | null = null;
let watchForNewSession = false;
let conn: DbConnection;
let interviewSocket: WebSocket | null = null;
let microphoneStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let audioProcessor: ScriptProcessorNode | null = null;
let captureEnabled = false;
let interviewTimer: ReturnType<typeof setTimeout> | undefined;

// ── DOM ─────────────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusPill = $("conn-status");
const personaForm = $("persona-form") as HTMLFormElement;
const nameInput = $("f-name") as HTMLInputElement;
const summaryInput = $("f-summary") as HTMLInputElement;
const interestsInput = $("f-interests") as HTMLInputElement;
const valuesInput = $("f-values") as HTMLInputElement;
const styleInput = $("f-style") as HTMLInputElement;
const voiceConsent = $("voice-consent") as HTMLInputElement;
const recordButton = $("voice-record") as HTMLButtonElement;
const stopButton = $("voice-stop") as HTMLButtonElement;
const voiceStatus = $("voice-status");
const voiceQuestion = $("voice-question");
const voiceTranscript = $("voice-transcript");
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

type PersonaDraft = {
  displayName: string;
  summary: string;
  interests: string[];
  values: string[];
  socialStyle: string;
};

function setVoiceStatus(
  message: string,
  state: "neutral" | "success" | "error" = "neutral",
): void {
  voiceStatus.textContent = message;
  voiceStatus.classList.toggle("success", state === "success");
  voiceStatus.classList.toggle("error", state === "error");
}

async function releaseMicrophone(): Promise<void> {
  clearTimeout(interviewTimer);
  interviewTimer = undefined;
  captureEnabled = false;
  audioProcessor?.disconnect();
  audioProcessor = null;
  microphoneStream?.getTracks().forEach((track) => track.stop());
  microphoneStream = null;
  if (audioContext) await audioContext.close();
  audioContext = null;
  stopButton.disabled = true;
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
  const bytes = Uint8Array.from(atob(audioBase64), (character) =>
    character.charCodeAt(0),
  );
  return bytes.buffer;
}

async function playAgentSpeech(
  audioBase64: string,
  _contentType: string,
): Promise<void> {
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

function applyPersonaDraft(persona: PersonaDraft): void {
  nameInput.value = persona.displayName;
  summaryInput.value = persona.summary;
  interestsInput.value = persona.interests.join(", ");
  valuesInput.value = persona.values.join(", ");
  styleInput.value = persona.socialStyle;
}

type InterviewMessage = {
  type?: string;
  state?: string;
  text?: string;
  reply?: string;
  question?: string;
  error?: string;
  audioBase64?: string;
  contentType?: string;
  persona?: PersonaDraft;
};

function handleInterviewMessage(message: InterviewMessage): void {
  if (message.type === "ready" && message.question) {
    voiceQuestion.textContent = `Wingman: ${message.question}`;
    voiceQuestion.classList.remove("hidden");
    stopButton.disabled = false;
    setVoiceStatus("Wingman is asking your first question…");
    return;
  }
  if (message.type === "transcript.partial" && message.text) {
    voiceTranscript.textContent = `You: ${message.text}`;
    voiceTranscript.classList.remove("hidden");
    return;
  }
  if (message.type === "transcript.final" && message.text) {
    voiceTranscript.textContent = `You: ${message.text}`;
    voiceTranscript.classList.remove("hidden");
    captureEnabled = false;
    return;
  }
  if (message.type === "question" && message.question) {
    voiceQuestion.textContent = `Wingman: ${message.reply ?? ""} ${message.question}`;
    voiceQuestion.classList.remove("hidden");
    captureEnabled = false;
    return;
  }
  if (message.type === "reply" && message.text) {
    voiceQuestion.textContent = `Wingman: ${message.text}`;
    voiceQuestion.classList.remove("hidden");
    captureEnabled = false;
    return;
  }
  if (
    message.type === "speech" &&
    message.audioBase64 &&
    message.contentType
  ) {
    void playAgentSpeech(message.audioBase64, message.contentType)
      .then(() => {
        if (interviewSocket?.readyState === WebSocket.OPEN) {
          captureEnabled = true;
          setVoiceStatus("Listening… answer naturally, then pause for five seconds.");
        }
      })
      .catch(() => {
        captureEnabled = true;
        setVoiceStatus("Audio playback failed. Answer the question shown above.", "error");
      });
    return;
  }
  if (message.type === "speech.unavailable") {
    captureEnabled = true;
    setVoiceStatus("Voice playback is unavailable. Answer the question shown above.");
    return;
  }
  if (message.type === "finish.rejected") {
    captureEnabled = true;
    stopButton.disabled = false;
    setVoiceStatus(message.error ?? "Answer a question before finishing.", "error");
    return;
  }
  if (message.type === "status") {
    const labels: Record<string, string> = {
      thinking: "Wingman is thinking of a follow-up…",
      generating_speech: "Wingman is preparing its voice response…",
      creating_persona: "Creating your persona draft…",
    };
    if (message.state && labels[message.state]) {
      setVoiceStatus(labels[message.state]);
    }
    return;
  }
  if (message.type === "persona" && message.persona) {
    applyPersonaDraft(message.persona);
    void releaseMicrophone();
    interviewSocket?.close();
    interviewSocket = null;
    recordButton.disabled = false;
    setVoiceStatus(
      "Persona draft ready. Review it below, then create your persona.",
      "success",
    );
    summaryInput.focus();
    return;
  }
  if (message.type === "error") {
    setVoiceStatus(message.error ?? "Voice interview failed. Please try again.", "error");
  }
}

async function startVoiceInterview(): Promise<void> {
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
  audioProcessor = audioContext.createScriptProcessor(4096, 1, 1);
  const silentOutput = audioContext.createGain();
  silentOutput.gain.value = 0;
  source.connect(audioProcessor);
  audioProcessor.connect(silentOutput);
  silentOutput.connect(audioContext.destination);

  const webSocketUrl = new URL(
    ORCHESTRATOR_URL.replace(/^http/, "ws") + "/api/interview/stream",
  );
  webSocketUrl.searchParams.set("displayName", nameInput.value.trim());
  webSocketUrl.searchParams.set("language", "en");
  interviewSocket = new WebSocket(webSocketUrl);
  interviewSocket.binaryType = "arraybuffer";

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
      setVoiceStatus("Wingman sent an invalid interview response.", "error");
    }
  });
  interviewSocket.addEventListener("close", () => {
    if (summaryInput.value.trim()) return;
    void releaseMicrophone();
    recordButton.disabled = false;
  });
  interviewSocket.addEventListener("error", () => {
    setVoiceStatus("Could not connect to the voice interview.", "error");
    void releaseMicrophone();
    recordButton.disabled = false;
  });

  recordButton.disabled = true;
  stopButton.disabled = true;
  voiceQuestion.classList.add("hidden");
  voiceTranscript.classList.add("hidden");
  setVoiceStatus("Connecting to Wingman…");
  interviewTimer = setTimeout(() => {
    if (interviewSocket?.readyState === WebSocket.OPEN) {
      captureEnabled = false;
      interviewSocket.send(JSON.stringify({ type: "finish" }));
      setVoiceStatus("Creating your persona…");
    }
  }, MAX_INTERVIEW_MS);
}

recordButton.addEventListener("click", async () => {
  if (!nameInput.value.trim()) {
    setVoiceStatus("Enter your display name before starting.", "error");
    nameInput.focus();
    return;
  }
  if (!voiceConsent.checked) {
    setVoiceStatus("Please confirm consent before starting.", "error");
    voiceConsent.focus();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
    setVoiceStatus(
      "Live voice is unavailable in this browser. Enter your persona manually below.",
      "error",
    );
    return;
  }

  try {
    await startVoiceInterview();
  } catch {
    await releaseMicrophone();
    interviewSocket?.close();
    interviewSocket = null;
    recordButton.disabled = false;
    setVoiceStatus(
      "Microphone access failed. Allow access and retry, or enter your persona manually.",
      "error",
    );
  }
});

stopButton.addEventListener("click", () => {
  if (interviewSocket?.readyState !== WebSocket.OPEN) return;
  captureEnabled = false;
  stopButton.disabled = true;
  interviewSocket.send(JSON.stringify({ type: "finish" }));
  setVoiceStatus("Finishing your answer and creating your persona…");
});

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
      .onApplied((_ctx: SubscriptionEventContext) => {
        // Restore the board/results from durable state after a page reload.
        restoreActiveSession();
        scheduleRender();
      })
      .onError((ctx: ErrorContext) => console.error("Subscription error:", ctx.event))
      // Server-side clientVisibilityFilter exports in the SpacetimeDB module
      // enforce participant-only access for match_session, conversation,
      // message, and match_result. SELECT * is safe: the server strips
      // unauthorised rows before they reach this client.
      .subscribe([
        "SELECT * FROM my_persona",
        "SELECT * FROM match_session",
        "SELECT * FROM conversation",
        "SELECT * FROM message",
        "SELECT * FROM match_result",
      ]);

    // Re-render on any change to subscribed tables.
    const bump = () => scheduleRender();
    c.db.myPersona.onInsert(bump);
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
    displayName: nameInput.value.trim(),
    summary: summaryInput.value.trim(),
    interests: csv(interestsInput.value),
    values: csv(valuesInput.value),
    socialStyle: styleInput.value.trim(),
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

convosEl.addEventListener("click", async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
  if (!button || !conn || activeSessionId === null) return;
  const session = conn.db.matchSession.id.find(activeSessionId);
  const conversationId = button.dataset.conversationId;
  if (!session || !conversationId) return;

  const args = {
    conversationId: BigInt(conversationId),
    personaId: session.initiatorPersonaId,
  };
  button.disabled = true;
  try {
    if (button.dataset.action === "takeover") {
      await conn.reducers.takeOverConversation(args);
    } else if (button.dataset.action === "release") {
      await conn.reducers.releaseConversation(args);
    } else if (button.dataset.action === "send") {
      const input = convosEl.querySelector<HTMLInputElement>(
        `input[data-human-input="${conversationId}"]`,
      );
      const content = input?.value.trim() ?? "";
      if (!content) return;
      await conn.reducers.sendHumanMessage({ ...args, content });
      if (input) input.value = "";
    }
  } catch (error) {
    console.error("Conversation action failed:", error);
  } finally {
    button.disabled = false;
  }
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
  if (!conn) return [];
  // `my_persona` is an owner-scoped view — every row it returns is already mine.
  return [...conn.db.myPersona.iter()].sort((a, b) =>
    Number(a.createdAt.microsSinceUnixEpoch - b.createdAt.microsSinceUnixEpoch),
  );
}

/** After a reload, re-adopt this user's newest session so the board reappears. */
function restoreActiveSession() {
  if (activeSessionId !== null || watchForNewSession) return;
  const me = myIdentity;
  if (!conn || !me) return;
  const mine = [...conn.db.matchSession.iter()]
    .filter((s) => s.owner.equals(me))
    .sort((a, b) => Number(b.createdAt.microsSinceUnixEpoch - a.createdAt.microsSinceUnixEpoch));
  if (mine.length === 0) return;
  // Prefer a live (matching) session; otherwise show the most recent finished one.
  const live = mine.find((s) => s.status === "matching");
  activeSessionId = (live ?? mine[0]).id;
}

/** Qualitative live signal — a direction indicator, not a compatibility %. */
function signalLabel(s: number): string {
  if (s >= 65) return "🔥 strong signal";
  if (s >= 35) return "good signal";
  return "warming up";
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
      : session.status === "timed_out"
        ? `Time expired — ranked ${complete} completed conversation${complete === 1 ? "" : "s"}.`
      : `Chatting live · ${complete}/${session.totalConversations} conversations wrapped`;

  convosEl.innerHTML = "";
  for (const convo of shown) {
    const msgs = [...conn.db.message.iter()]
      .filter((m) => m.conversationId === convo.id)
      .sort((a, b) => a.seq - b.seq);

    const card = document.createElement("div");
    card.className = "convo";
    const hot = convo.signalStrength >= 65 ? "hot" : "";
    const controlledByMe =
      convo.controlMode === "human" &&
      convo.humanPersonaId === session.initiatorPersonaId;
    const controls =
      convo.status === "complete"
        ? ""
        : controlledByMe
          ? `<div class="takeover-controls">
              <input data-human-input="${convo.id}" placeholder="Write your message…" maxlength="2000" />
              <button data-action="send" data-conversation-id="${convo.id}">Send</button>
              <button data-action="release" data-conversation-id="${convo.id}">Return to agent</button>
            </div>`
          : convo.controlMode === "agent"
            ? `<button data-action="takeover" data-conversation-id="${convo.id}">Take over</button>`
            : `<span class="muted">Human joined this conversation</span>`;
    card.innerHTML = `
      <div class="convo-head">
        <strong>${escapeHtml(convo.partnerDisplayName)}</strong>
        <span class="signal ${hot}">${signalLabel(convo.signalStrength)}</span>
      </div>
      <div class="bar"><span style="width:${convo.signalStrength}%"></span></div>
      <div class="msgs">
        ${msgs
          .map(
            (m) =>
              `<div class="msg"><span class="who">${escapeHtml(m.senderName)}:</span> ${escapeHtml(m.content)}</div>`,
          )
          .join("")}
      </div>
      ${controls}`;
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
          <div class="badge">${r.rank === 1 ? "Top match" : `#${r.rank}`}</div>
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
