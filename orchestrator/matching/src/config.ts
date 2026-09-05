/**
 * Matching-orchestrator configuration. The team plan requires these to stay
 * configurable — override any of them via environment variables.
 */
export const CONFIG = {
  // SpacetimeDB connection (public config; no secrets here).
  SPACETIMEDB_URI: process.env.SPACETIMEDB_HOST ?? 'wss://maincloud.spacetimedb.com',
  MODULE_NAME: process.env.SPACETIMEDB_DATABASE ?? 'wingman',

  // Conversation generation + playback.
  TURNS_PER_CONVO: Number(process.env.TURNS_PER_CONVO ?? 8),
  CONCURRENCY: Number(process.env.CONCURRENCY ?? 6),
  PACING_MS: Number(process.env.PACING_MS ?? 500),
  DEADLINE_MS: Number(process.env.DEADLINE_MS ?? 180_000),

  // How often (every N turns) to push a signal-strength update during playback.
  SIGNAL_UPDATE_EVERY: Number(process.env.SIGNAL_UPDATE_EVERY ?? 2),

  // Where to persist the orchestrator's SpacetimeDB identity token so it keeps a
  // stable identity across restarts. Never commit this file.
  TOKEN_FILE: process.env.ORCHESTRATOR_TOKEN_FILE ?? '.orchestrator-token',
} as const;
