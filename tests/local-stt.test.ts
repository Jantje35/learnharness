import assert from "node:assert/strict";
import { test } from "node:test";
import { DICTATION_LANGUAGES, whisperLanguage } from "../src/core/dictation.ts";
import {
	bytesToBase64,
	concatFrames,
	encodeWav,
	MIN_SPEECH_SAMPLES,
	pcmFramesToWav,
	SAMPLE_RATE,
	SILENCE_PAD_SAMPLES,
	SILENCE_THRESHOLD,
	trimSilence,
	WAV_HEADER_BYTES,
} from "../src/core/wav.ts";

/** One worklet frame: `length` Int16 samples, all at `value`. */
function frame(length: number, value = 0): ArrayBuffer {
	const samples = new Int16Array(length).fill(value);
	return samples.buffer;
}

/** Speech-shaped frames: `silent` silence frames around `speech` loud ones. */
function utterance(silent: number, speech: number, value = 4000): ArrayBuffer[] {
	return [frame(silent), frame(speech, value), frame(silent)];
}

test("whisper language codes collapse locales and leave multi to the service default", () => {
	assert.equal(whisperLanguage("multi"), null);
	assert.equal(whisperLanguage("nl"), "nl");
	assert.equal(whisperLanguage("nl-BE"), "nl");
	assert.equal(whisperLanguage("pt-BR"), "pt");
	assert.equal(whisperLanguage("zh-Hant"), "zh");
	assert.equal(whisperLanguage("es-419"), "es");
	// Every offered preference yields an ISO-639-1 code whisper-svc accepts.
	for (const { code } of DICTATION_LANGUAGES) {
		const mapped = whisperLanguage(code);
		if (code === "multi") assert.equal(mapped, null);
		else assert.match(mapped!, /^[a-z]{2,3}$/, code);
	}
});

test("encodeWav writes a canonical 16 kHz mono 16-bit RIFF header", () => {
	const samples = new Int16Array(SAMPLE_RATE); // exactly one second
	const wav = encodeWav(samples);
	assert.equal(wav.length, WAV_HEADER_BYTES + SAMPLE_RATE * 2);
	const view = new DataView(wav.buffer);
	const ascii = (at: number, len: number) => String.fromCharCode(...wav.subarray(at, at + len));
	assert.equal(ascii(0, 4), "RIFF");
	assert.equal(view.getUint32(4, true), WAV_HEADER_BYTES - 8 + SAMPLE_RATE * 2);
	assert.equal(ascii(8, 4), "WAVE");
	assert.equal(ascii(12, 4), "fmt ");
	assert.equal(view.getUint32(16, true), 16, "fmt chunk size");
	assert.equal(view.getUint16(20, true), 1, "PCM");
	assert.equal(view.getUint16(22, true), 1, "mono");
	assert.equal(view.getUint32(24, true), SAMPLE_RATE);
	assert.equal(view.getUint32(28, true), SAMPLE_RATE * 2, "byte rate");
	assert.equal(view.getUint16(32, true), 2, "block align");
	assert.equal(view.getUint16(34, true), 16, "bits per sample");
	assert.equal(ascii(36, 4), "data");
	assert.equal(view.getUint32(40, true), SAMPLE_RATE * 2);
});

test("encodeWav carries the sample bytes in order", () => {
	const samples = Int16Array.from([0, 1, -1, 32767, -32768]);
	const wav = encodeWav(samples);
	const payload = new Int16Array(wav.buffer, WAV_HEADER_BYTES, samples.length);
	assert.deepEqual([...payload], [...samples]);
});

test("concatFrames preserves frame order and length", () => {
	const joined = concatFrames([frame(3, 1), frame(2, 2)]);
	assert.equal(joined.length, 5);
	assert.deepEqual([...joined], [1, 1, 1, 2, 2]);
});

test("trimSilence drops quiet head and tail but keeps a 200 ms pad", () => {
	const samples = new Int16Array(SAMPLE_RATE); // 1 s of silence
	samples.set(Int16Array.from({ length: 1000 }, () => SILENCE_THRESHOLD + 1), 8000);
	const trimmed = trimSilence(samples);
	assert.equal(trimmed.length, 1000 + SILENCE_PAD_SAMPLES * 2);
	assert.equal(trimmed[0], 0, "the pad is silence from before the first sample");
});

test("trimSilence returns nothing when the run held no speech", () => {
	const quiet = new Int16Array(SAMPLE_RATE).fill(SILENCE_THRESHOLD - 1);
	assert.equal(trimSilence(quiet).length, 0);
});

test("pcmFramesToWav refuses a speechless or too-short run", () => {
	assert.equal(pcmFramesToWav([]).length, 0);
	assert.equal(pcmFramesToWav([frame(2048)]).length, 0, "pure silence");
	const blip = Math.round(MIN_SPEECH_SAMPLES / 4);
	assert.equal(pcmFramesToWav([frame(blip, 5000)]).length, 0, "under the speech floor");
});

test("pcmFramesToWav encodes a real utterance as uploadable WAV", () => {
	const wav = pcmFramesToWav(utterance(4000, 16000));
	assert.ok(wav.length > WAV_HEADER_BYTES);
	assert.equal(String.fromCharCode(...wav.subarray(0, 4)), "RIFF");
	const dataBytes = new DataView(wav.buffer).getUint32(40, true);
	assert.equal(wav.length, WAV_HEADER_BYTES + dataBytes);
});

test("bytesToBase64 survives multi-chunk payloads", () => {
	const bytes = new Uint8Array(200_000);
	for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
	assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString("base64"));
	assert.equal(bytesToBase64(new Uint8Array(0)), "");
});
