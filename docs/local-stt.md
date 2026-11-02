# Local dictation (whisper-svc instead of Deepgram)

This fork replaces the cloud dictation transport with the homelab STT service.
Everything else about dictation — the meter, the target-input registry, the
deferred transcript, `finish()`/`cancel()` — is the upstream behaviour.

## What changed

| File | Change |
| --- | --- |
| `app/api/stt/transcribe/route.ts` | **new** — forwards a WAV + language to whisper-svc, returns `{text}`; `GET` is a health probe |
| `src/core/wav.ts` | **new** — frames → 16 kHz mono WAV (+ silence trim), base64 (pure, unit-tested) |
| `src/core/dictation.ts` | `whisperLanguage()` — locale → ISO-639-1 for whisper |
| `components/dictation.tsx` | transport switch `STT_ENGINE`: `deepgram` (upstream) or `whisper` (frames buffered, one upload at stop) |
| `src/core/settings.ts` | factory dictation language `nl` (whisper forces a language, so a wrong default garbles a first run) |
| `scripts/whisper-tunnel.sh` | keeps `127.0.0.1:8280` wired to whisper-svc on the GPU host |

The Deepgram path is untouched and stays the default when the switch is unset,
so rebasing onto upstream does not fight this diff.

## Setup

```bash
cp .env.local.example .env.local     # NEXT_PUBLIC_LH_STT_ENGINE=whisper
./scripts/whisper-tunnel.sh &        # .2 binds whisper-svc to 127.0.0.1 only
npm run dev
```

Check the wiring before blaming the UI:

```bash
curl -s localhost:3000/api/stt/transcribe        # {"ok":true,"base":...,"service":{"model":"large-v3-turbo"}}
```

`STT_BASE_URL` overrides the service address (default `http://127.0.0.1:8280`)
for a host that can reach whisper-svc without a tunnel.

## Behaviour

- **One transcript per run.** Frames accumulate while recording; the utterance
  is trimmed of leading/trailing silence, encoded as WAV and POSTed once when
  dictation stops. Upstream already defers text until teardown, so the visible
  behaviour is identical — only the latency moves to the end of the run.
- **No live partials.** whisper-svc is a batch service (`/transcribe`), not a
  stream. A tap that produced under 250 ms of speech never leaves the browser:
  the button says `No speech detected` instead.
- **Language is forced.** whisper-svc runs `model.transcribe(language=...)`
  with no auto-detect (`language: "auto"` is rejected). The app's language
  picker maps to a base code (`pt-BR` → `pt`). `Multilingual` sends no language
  at all, which resolves to the service default — `nl`.
- **Latency:** measured 0.6–0.9 s for a ~20 s Dutch clip through the tunnel
  (large-v3-turbo, warm).
- **Ceiling:** 10 minutes of audio per run (client cap), ~28 MB JSON body, and
  whisper-svc serialises requests behind a lock — two dictations at once queue.

## Models

The app itself still needs a model provider. On this host the local Ollama
server works as a custom OpenAI-compatible endpoint:
`http://127.0.0.1:11434/v1` (server-side calls, so loopback is fine). Cloud
tags (`:cloud`) only work on the Ollama instance that is signed in.

## Tests

```bash
npx tsx --test tests/local-stt.test.ts tests/dictation-local.test.tsx
```

`local-stt` covers the WAV/trim/base64 maths and the language mapping;
`dictation-local` drives the hook with hand-made worklet frames and asserts
exactly one upload, the WAV header, the language, and the single deferred
flush. The upstream `dictation-flow`/`dictation-warm` suites still cover the
Deepgram path.
