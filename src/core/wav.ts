/**
 * Local dictation audio (fork: NEXT_PUBLIC_LH_STT_ENGINE=whisper).
 *
 * The cloud path streams raw linear16 frames straight to Deepgram, so it
 * never needs a container. whisper-svc (the homelab STT service behind
 * /api/stt/transcribe) takes a FILE: it runs ffmpeg over the payload, which
 * needs a real WAV header, and it silently returns garbage for headerless
 * PCM. So the local path encodes the captured frames once, at stop.
 *
 * Pure functions on purpose: no DOM, no fetch — `npm test` covers them
 * without a browser (tests/local-stt.test.ts).
 */

/** 16 kHz mono 16-bit — matches the pcm-capture worklet and whisper-svc. */
export const SAMPLE_RATE = 16000;
export const BYTES_PER_SAMPLE = 2;
export const WAV_HEADER_BYTES = 44;

/** |sample| below this is silence: ≈ -42 dBFS of the Int16 range. Chosen
 *  against the homelab mic profile (noise floor 700-2300 rms in the
 *  Float32 domain ≈ 20-70 Int16 rms; speech sits 10-30× higher). */
export const SILENCE_THRESHOLD = 400;

/** Silence kept around the first/last speech sample (200 ms). */
export const SILENCE_PAD_SAMPLES = Math.round(SAMPLE_RATE * 0.2);

/** Speech shorter than this is not worth a round trip (250 ms). */
export const MIN_SPEECH_SAMPLES = Math.round(SAMPLE_RATE * 0.25);

/** Trim leading/trailing silence in the Int16 domain. Whisper hallucinates
 *  on long silent stretches ("Ondertitels door het Amara-team"), so the
 *  quiet head and tail of a dictation run never reach the service. */
export function trimSilence(samples: Int16Array): Int16Array {
	let first = -1;
	let last = -1;
	for (let i = 0; i < samples.length; i++) {
		const sample = samples[i]!;
		const abs = sample < 0 ? -sample : sample;
		if (abs >= SILENCE_THRESHOLD) {
			if (first === -1) first = i;
			last = i;
		}
	}
	if (first === -1) return samples.subarray(0, 0);
	const from = Math.max(0, first - SILENCE_PAD_SAMPLES);
	const to = Math.min(samples.length, last + 1 + SILENCE_PAD_SAMPLES);
	return samples.subarray(from, to);
}

/** Concatenate the worklet's transferred frames into one sample buffer. */
export function concatFrames(frames: ArrayBuffer[]): Int16Array {
	let total = 0;
	for (const frame of frames) total += frame.byteLength;
	const out = new Int16Array(total / BYTES_PER_SAMPLE);
	let at = 0;
	for (const frame of frames) {
		const chunk = new Int16Array(frame);
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}

function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
	for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
}

/** Wrap Int16 samples in a 44-byte RIFF/WAVE header (canonical PCM layout). */
export function encodeWav(samples: Int16Array): Uint8Array {
	const dataBytes = samples.length * BYTES_PER_SAMPLE;
	const out = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
	const view = new DataView(out.buffer);
	writeAscii(out, 0, "RIFF");
	view.setUint32(4, WAV_HEADER_BYTES - 8 + dataBytes, true);
	writeAscii(out, 8, "WAVE");
	writeAscii(out, 12, "fmt ");
	view.setUint32(16, 16, true); // fmt chunk size
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, SAMPLE_RATE, true);
	view.setUint32(28, SAMPLE_RATE * BYTES_PER_SAMPLE, true); // byte rate
	view.setUint16(32, BYTES_PER_SAMPLE, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	writeAscii(out, 36, "data");
	view.setUint32(40, dataBytes, true);
	out.set(new Uint8Array(samples.buffer, samples.byteOffset, dataBytes), WAV_HEADER_BYTES);
	return out;
}

/**
 * Captured frames → uploadable WAV. Returns an EMPTY array when the run held
 * no speech (the caller surfaces "No speech detected" instead of paying for
 * a round trip that would return an empty or hallucinated line).
 */
export function pcmFramesToWav(frames: ArrayBuffer[]): Uint8Array {
	const samples = trimSilence(concatFrames(frames));
	if (samples.length < MIN_SPEECH_SAMPLES) return new Uint8Array(0);
	return encodeWav(samples);
}

/** Base64 for the JSON body. Chunked: spreading a multi-MB array into
 *  String.fromCharCode blows the argument limit. */
export function bytesToBase64(bytes: Uint8Array): string {
	const CHUNK = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}
