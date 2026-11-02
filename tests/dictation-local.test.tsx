import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import type { UserSettings } from "../src/core/index.ts";

/**
 * The local transport, exercised without a microphone: the worklet's audio
 * messages are produced by hand, and the only assertion that matters is what
 * leaves the page — one POST to /api/stt/transcribe carrying a real WAV.
 *
 * STT_ENGINE is read at module load, so the env is set before the import.
 */
process.env.NEXT_PUBLIC_LH_STT_ENGINE = "whisper";

class AudioGraph {
	state = "running";
	destination = {};
	audioWorklet = { addModule: async () => {} };
	createMediaStreamSource() {
		return { connect() {}, disconnect() {} };
	}
}

class Worklet {
	static all: Worklet[] = [];
	port: { onmessage: ((event: { data: unknown }) => void) | null } = { onmessage: null };
	connect() {}
	disconnect() {}
	constructor() {
		Worklet.all.push(this);
	}
	emit(data: unknown) {
		this.port.onmessage?.({ data });
	}
	/** `count` speech frames (2048 samples each, well above the noise floor). */
	speak(count = 8, value = 4000) {
		for (let i = 0; i < count; i++) {
			this.emit({ type: "audio", buffer: new Int16Array(2048).fill(value).buffer });
		}
	}
}

type Call = { url: string; init: RequestInit };

const globals = globalThis as Record<string, unknown>;
let restore: (() => void) | undefined;
let unmount: (() => Promise<void>) | undefined;

async function fixture(transcript: string | null = "hallo wereld") {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const state = {
		appends: [] as string[],
		calls: [] as Call[],
	};
	Worklet.all = [];
	const record: UserSettings = { version: 1, dictation: { language: "nl" } };
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const values: Record<string, unknown> = {
		React,
		window: dom.window,
		document: dom.document,
		CustomEvent: dom.window.CustomEvent,
		navigator: {
			userAgent: "",
			platform: "",
			mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
		},
		AudioContext: AudioGraph,
		AudioWorkletNode: Worklet,
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string, init?: RequestInit) => {
			state.calls.push({ url, init: init ?? {} });
			if (url === "/api/settings") return Response.json({ settings: record });
			if (url === "/api/stt/transcribe") {
				if (transcript === null) return Response.json({ message: "whisper-svc unreachable" }, { status: 502 });
				return Response.json({ text: transcript });
			}
			throw new Error(`unexpected fetch ${url}`);
		},
	};
	for (const [key, value] of Object.entries(values)) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	restore = () => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	};

	const { useDictation } = await import("../components/dictation.tsx");
	type Dictation = ReturnType<typeof useDictation>;
	const { createRoot } = await import("react-dom/client");
	let latest!: Dictation;
	function Harness() {
		latest = useDictation({ append: (text: string) => state.appends.push(text) });
		return null;
	}
	const root = createRoot(document.getElementById("root")!);
	unmount = async () => {
		await act(async () => {
			root.unmount();
		});
	};
	await act(async () => {
		root.render(<Harness />);
	});
	return {
		state,
		get dictation() {
			return latest;
		},
		get worklet() {
			return Worklet.all.at(-1)!;
		},
	};
}

/** Let the run's awaits (settings → mic → fetch) drain. */
async function settle() {
	await act(async () => {
		for (let i = 0; i < 5; i++) await new Promise((done) => setImmediate(done));
	});
}

afterEach(async () => {
	await unmount?.();
	unmount = undefined;
	restore?.();
	restore = undefined;
});

test("a local run uploads one 16 kHz WAV and flushes its transcript at teardown", async () => {
	const f = await fixture("hallo wereld");
	await act(async () => {
		f.dictation.toggle();
	});
	await settle();
	assert.equal(f.dictation.phase, "recording", "capture is live — no handshake to wait for");
	assert.equal(f.state.calls.filter((call) => call.url === "/api/stt/transcribe").length, 0, "nothing sent while recording");

	await act(async () => {
		f.worklet.emit({ type: "level", rms: 0.2 });
		f.worklet.speak(8);
	});
	assert.deepEqual(f.state.appends, [], "deferred: no text while recording");

	await act(async () => {
		f.dictation.stop();
	});
	await settle();

	assert.equal(f.dictation.phase, "idle");
	assert.deepEqual(f.state.appends, ["hallo wereld"], "flushed exactly once");

	const uploads = f.state.calls.filter((call) => call.url === "/api/stt/transcribe");
	assert.equal(uploads.length, 1);
	const body = JSON.parse(uploads[0]!.init.body as string) as { audio_base64: string; language: string };
	assert.equal(body.language, "nl");
	const wav = Buffer.from(body.audio_base64, "base64");
	assert.equal(wav.subarray(0, 4).toString(), "RIFF");
	assert.equal(wav.subarray(8, 12).toString(), "WAVE");
	assert.equal(new DataView(wav.buffer, wav.byteOffset).getUint32(24, true), 16000, "16 kHz mono");
	// 8 frames × 2048 samples of speech, trimmed to the speech plus its pad.
	assert.equal(new DataView(wav.buffer, wav.byteOffset).getUint32(40, true), 8 * 2048 * 2);
});

test("a silent run never reaches the service and says so", async () => {
	const f = await fixture("moet niet binnenkomen");
	await act(async () => {
		f.dictation.toggle();
	});
	await settle();
	await act(async () => {
		f.worklet.speak(4, 10); // below the silence threshold
	});
	await act(async () => {
		f.dictation.stop();
	});
	await settle();

	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.dictation.error, "No speech detected");
	assert.equal(f.state.calls.filter((call) => call.url === "/api/stt/transcribe").length, 0);
	assert.deepEqual(f.state.appends, []);
});

test("a failed upload surfaces the route's message and keeps the text field clean", async () => {
	const f = await fixture(null);
	await act(async () => {
		f.dictation.toggle();
	});
	await settle();
	await act(async () => {
		f.worklet.speak(8);
	});
	await act(async () => {
		f.dictation.stop();
	});
	await settle();

	assert.equal(f.dictation.phase, "idle");
	assert.match(f.dictation.error ?? "", /whisper-svc unreachable/);
	assert.deepEqual(f.state.appends, []);
});

test("cancel discards the captured audio instead of uploading it", async () => {
	const f = await fixture();
	await act(async () => {
		f.dictation.toggle();
	});
	await settle();
	await act(async () => {
		f.worklet.speak(8);
	});
	await act(async () => {
		f.dictation.cancel();
	});
	await settle();

	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.state.calls.filter((call) => call.url === "/api/stt/transcribe").length, 0);
	assert.deepEqual(f.state.appends, []);
});
