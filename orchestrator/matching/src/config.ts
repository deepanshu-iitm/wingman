/**
 * Matching-orchestrator configuration. The team plan requires these to stay
 * configurable — override any of them via environment variables.
 */
export const CONFIG = {
  // SpacetimeDB connection (public config; no secrets here).
  SPACETIMEDB_URI: process.env.SPACETIMEDB_HOST ?? 'wss://maincloud.spacetimedb.com',
  MODULE_NAME: process.env.SPACETIMEDB_DATABASE ?? 'wingman',

  // Conversation generation + playback.
  TURNS_PER_CONVO: Number(process.env.TURNS_PER_CONVO ?? 8), // placeholder default
  // A conversation runs free-flowing between these bounds: it may close early
  // (from MIN onward) once both agents naturally say goodbye, but never exceeds
  // MAX. The last turns are always a graceful wrap-up, not a hard cutoff.
  MIN_TURNS_PER_CONVO: Number(process.env.MIN_TURNS_PER_CONVO ?? 6),
  MAX_TURNS_PER_CONVO: Number(process.env.MAX_TURNS_PER_CONVO ?? 14),
  // Soft per-conversation wall-clock budget: once exceeded (and past MIN turns)
  // the agents are told to wind down. Kept under the module's 180s hard
  // watchdog so the wrap-up happens gracefully before the net fires.
  CONVO_SOFT_MS: Number(process.env.CONVO_SOFT_MS ?? 120_000),
  CONCURRENCY: Number(process.env.CONCURRENCY ?? 6),
  PACING_MS: Number(process.env.PACING_MS ?? 500),
  DEADLINE_MS: Number(process.env.DEADLINE_MS ?? 180_000),
  RETRY_SCAN_MS: Number(process.env.RETRY_SCAN_MS ?? 3_000),

  // How often (every N turns) to push a signal-strength update during playback.
  SIGNAL_UPDATE_EVERY: Number(process.env.SIGNAL_UPDATE_EVERY ?? 2),

  // Where to persist the orchestrator's SpacetimeDB identity token so it keeps a
  // stable identity across restarts. Never commit this file.
  TOKEN_FILE: process.env.ORCHESTRATOR_TOKEN_FILE ?? '.orchestrator-token',
} as const;
