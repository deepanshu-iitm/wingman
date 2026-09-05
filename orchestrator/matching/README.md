# Matching orchestrator (`@wingman/matching-orchestrator`)

Server-side worker for the **"Match Me"** flow. It is a **sibling** to the
voice/persona orchestrator in `orchestrator/` and lives in its own folder so the
two services never fight over `package.json` / `tsconfig.json` (this one uses
npm + `tsx`; the voice service uses pnpm + `node --experimental-strip-types`).

## What it does

SpacetimeDB reducers are deterministic and cannot call an LLM, so this process
is what actually *generates* the agent-to-agent conversations:

1. connects to SpacetimeDB with its own stable service identity,
2. watches for `match_session` rows in status `matching`,
3. for each pending `conversation`, calls `generateConversation(A, B)` and plays
   the transcript back into the DB at a human pace via reducers, ramping the live
   "signal",
4. calls `finalizeSession` once every conversation is complete.

The module owns all durable state + the ranking/calibration math; this worker
only generates and paces. The `deadline_timer` watchdog in the module is the
crash-safety net.

`src/generateConversation.ts` is the **only LLM-touching seam**. It ships in
deterministic placeholder mode (no API key needed); swap it for a single OpenAI
call to go live — the return shape stays identical.

## Run

```bash
cd orchestrator/matching
npm install
SPACETIMEDB_DATABASE=wingman npm start
```

## Verify

```bash
npm run typecheck
```
