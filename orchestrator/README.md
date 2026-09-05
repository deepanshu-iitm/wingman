# Wingman orchestrator

Private server-side integration for voice transcription and persona extraction.
Provider credentials must never be used directly by the browser.

## Run locally

From the repository root, copy `.env.example` to `.env` and fill in the
required keys. Then:

```powershell
cd orchestrator
pnpm install
pnpm dev
```

Open `http://localhost:8787/demo` to test the isolated voice onboarding flow.

## Verify

```powershell
pnpm typecheck
pnpm test
```

## Endpoints

### `GET /health`

Returns the service status.

### `POST /api/transcribe?language=en`

Accepts raw audio bytes with a supported audio content type. Returns:

```json
{
  "transcript": "Transcribed speech"
}
```

The current request limit is 20 MB.

### `POST /api/persona`

Accepts:

```json
{
  "displayName": "A name collected during instant entry",
  "transcript": "The confirmed onboarding transcript"
}
```

Returns a validated persona draft containing `displayName`, `summary`,
`interests`, `values`, and `socialStyle`.
