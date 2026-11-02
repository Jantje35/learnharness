/**
 * Local dictation endpoint (fork: NEXT_PUBLIC_LH_STT_ENGINE=whisper).
 *
 * The renderer records the mic with the upstream pcm-capture worklet
 * (16 kHz mono linear16), wraps the utterance in a WAV header
 * (src/core/wav.ts) and POSTs it here. This route forwards it to
 * whisper-svc — the homelab STT service, which takes
 * {audio_base64, language} and answers {ok, transcript, latency}.
 * Audio never leaves the LAN and no provider key is involved.
 *
 * STT_BASE_URL defaults to 127.0.0.1:8280 because whisper-svc binds to
 * localhost on its own machine; when the app runs elsewhere keep an SSH
 * tunnel up (scripts/whisper-tunnel.sh). Set STT_BASE_URL to skip the tunnel
 * on a host that can reach the service directly.
 *
 * Language contract: whisper-svc FORCES a language (payload.get("language")
 * or "nl") — there is no auto-detect. The client maps the app's dictation
 * language to a whisper code and omits it for "multi", which therefore
 * resolves to the service default (nl).
 */

/** whisper-svc base URL. No trailing slash; the route appends the path. */
const STT_BASE_URL = (process.env.STT_BASE_URL ?? "http://127.0.0.1:8280").replace(/\/+$/, "");

/** 10 minutes of 16 kHz mono linear16 ≈ 19 MB, base64 ≈ 26 MB. */
const MAX_BASE64_CHARS = 28 * 1024 * 1024;

/** whisper-svc is single-threaded and holds a lock; a long utterance can
 *  queue behind another caller. Generous, but finite. */
const TRANSCRIBE_TIMEOUT_MS = 120_000;

export async function POST(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ message: "Invalid JSON body" }, { status: 400 });
	}
	const { audio_base64: audioBase64, language } = (body ?? {}) as {
		audio_base64?: unknown;
		language?: unknown;
	};
	if (typeof audioBase64 !== "string" || audioBase64.length === 0) {
		return Response.json({ message: "Missing audio_base64" }, { status: 400 });
	}
	if (audioBase64.length > MAX_BASE64_CHARS) {
		return Response.json({ message: "Recording too long for one dictation run" }, { status: 413 });
	}
	const languageCode = typeof language === "string" ? language.trim().toLowerCase() : "";
	if (languageCode && !/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(languageCode)) {
		return Response.json({ message: "Unsupported language code" }, { status: 400 });
	}

	try {
		const res = await fetch(`${STT_BASE_URL}/transcribe`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(
				languageCode ? { audio_base64: audioBase64, language: languageCode } : { audio_base64: audioBase64 },
			),
			signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
		});
		if (!res.ok) {
			return Response.json({ message: `whisper-svc answered HTTP ${res.status}` }, { status: 502 });
		}
		const payload = (await res.json()) as { ok?: boolean; transcript?: string; error?: string };
		if (!payload.ok) {
			return Response.json({ message: payload.error ?? "whisper-svc transcription failed" }, { status: 502 });
		}
		return Response.json({ text: (payload.transcript ?? "").trim() });
	} catch (error) {
		const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
		return Response.json(
			{
				message: timedOut
					? `whisper-svc timed out after ${TRANSCRIBE_TIMEOUT_MS / 1000}s at ${STT_BASE_URL}`
					: `whisper-svc unreachable at ${STT_BASE_URL} — is the SSH tunnel up? (scripts/whisper-tunnel.sh)`,
			},
			{ status: 502 },
		);
	}
}

/** Health probe for debugging: does the route actually see the service? */
export async function GET() {
	try {
		const res = await fetch(`${STT_BASE_URL}/health`, {
			signal: AbortSignal.timeout(5_000),
			cache: "no-store",
		});
		if (!res.ok) {
			return Response.json({ ok: false, base: STT_BASE_URL, message: `HTTP ${res.status}` }, { status: 502 });
		}
		return Response.json({ ok: true, base: STT_BASE_URL, service: await res.json() });
	} catch {
		return Response.json({ ok: false, base: STT_BASE_URL, message: "unreachable" }, { status: 502 });
	}
}
