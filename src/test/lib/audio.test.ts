import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EmptyRecordingError,
  encodeWav,
  extFor,
  pickMimeType,
  speakQuestion,
  stopQuestionAudio,
  transcribeBlob,
  wavHeader,
} from "../../lib/audio";

// callEdgeAudio / callEdgeForm are module-mocked below so speakQuestion and
// transcribeBlob never hit the network during unit tests. (A vi.spyOn on a
// throwaway object would not intercept the module binding audio.ts imports.)
const mocks = vi.hoisted(() => ({ callEdgeAudio: vi.fn(), callEdgeForm: vi.fn() }));

vi.mock("../../lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/config")>();
  return { ...actual, callEdgeAudio: mocks.callEdgeAudio, callEdgeForm: mocks.callEdgeForm };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extFor", () => {
  it("maps mp4 to m4a, aac to aac, and everything else to webm", () => {
    expect(extFor("audio/mp4")).toBe("m4a");
    expect(extFor("audio/aac")).toBe("aac");
    expect(extFor("audio/webm")).toBe("webm");
    expect(extFor("audio/webm;codecs=opus")).toBe("webm");
  });
});

describe("pickMimeType", () => {
  it("returns null when MediaRecorder is undefined", () => {
    expect(pickMimeType()).toBeNull();
  });

  it("returns the first supported candidate type", () => {
    const isTypeSupported = vi
      .fn()
      .mockImplementation((t: string) => t === "audio/mp4"); // webm unsupported, mp4 supported
    vi.stubGlobal("MediaRecorder", { isTypeSupported });
    expect(pickMimeType()).toBe("audio/mp4");
  });

  it("returns null when nothing is supported", () => {
    vi.stubGlobal("MediaRecorder", { isTypeSupported: () => false });
    expect(pickMimeType()).toBeNull();
  });
});

// --- WAV encoding ----------------------------------------------------------
// The header writer is pure; encodeWav/transcribeBlob need a stubbed
// OfflineAudioContext because jsdom has no Web Audio implementation.

function seedOfflineAudioContext(decoded: Float32Array, rendered: Float32Array) {
  class FakeOfflineAudioContext {
    length: number;
    constructor(_channels: number, length: number, _sampleRate: number) {
      this.length = length;
    }
    async decodeAudioData(_buf: ArrayBuffer) {
      return { length: decoded.length, sampleRate: 48000, getChannelData: () => decoded };
    }
    createBufferSource() {
      return { buffer: null, connect: vi.fn(), start: vi.fn() };
    }
    async startRendering() {
      return { getChannelData: () => rendered };
    }
  }
  vi.stubGlobal("OfflineAudioContext", FakeOfflineAudioContext);
}

describe("wavHeader", () => {
  it("writes a canonical 44-byte 16-bit PCM mono 16 kHz header", () => {
    const buf = wavHeader(1000);
    const v = new DataView(buf);
    expect(buf.byteLength).toBe(44);
    expect(String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3))).toBe("RIFF");
    expect(v.getUint32(4, true)).toBe(36 + 1000); // RIFF chunk size = 36 + data
    expect(String.fromCharCode(v.getUint8(8), v.getUint8(9), v.getUint8(10), v.getUint8(11))).toBe("WAVE");
    expect(String.fromCharCode(v.getUint8(12), v.getUint8(13), v.getUint8(14), v.getUint8(15))).toBe("fmt ");
    expect(v.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(28, true)).toBe(32000); // byteRate = 16000 * 1 * 16 / 8
    expect(v.getUint16(32, true)).toBe(2); // blockAlign
    expect(v.getUint16(34, true)).toBe(16);
    expect(String.fromCharCode(v.getUint8(36), v.getUint8(37), v.getUint8(38), v.getUint8(39))).toBe("data");
    expect(v.getUint32(40, true)).toBe(1000);
  });
});

describe("encodeWav", () => {
  it("converts a decoded recording to a 16 kHz mono 16-bit PCM WAV blob", async () => {
    seedOfflineAudioContext(new Float32Array([0, 0.5, -0.5]), new Float32Array([0, 0.5, -0.5]));
    const wav = await encodeWav(new Blob([new Uint8Array(500)], { type: "audio/webm" }));
    expect(wav.type).toBe("audio/wav");
    const bytes = new Uint8Array(await wav.arrayBuffer());
    expect(bytes.byteLength).toBe(44 + 6); // header + 3 samples × 2 bytes
    const v = new DataView(bytes.buffer);
    expect(v.getUint32(40, true)).toBe(6); // data chunk byte length
    expect(v.getInt16(44, true)).toBe(0);
    expect(v.getInt16(46, true)).toBe(Math.round(0.5 * 0x7fff));
    expect(v.getInt16(48, true)).toBe(-Math.round(0.5 * 0x8000));
  });

  it("throws EmptyRecordingError for a recording that never started (tiny blob)", async () => {
    await expect(encodeWav(new Blob([new Uint8Array(10)], { type: "audio/webm" }))).rejects.toBeInstanceOf(
      EmptyRecordingError,
    );
  });

  it("throws EmptyRecordingError when decoding yields zero samples", async () => {
    seedOfflineAudioContext(new Float32Array(0), new Float32Array(0));
    await expect(encodeWav(new Blob([new Uint8Array(500)], { type: "audio/webm" }))).rejects.toBeInstanceOf(
      EmptyRecordingError,
    );
  });
});

describe("transcribeBlob", () => {
  it("encodes the recording to WAV and uploads it as answer-N.wav", async () => {
    seedOfflineAudioContext(new Float32Array([0, 0.5]), new Float32Array([0, 0.5]));
    mocks.callEdgeForm.mockResolvedValue({ transcript: "Hello there" });
    const text = await transcribeBlob(new Blob([new Uint8Array(500)], { type: "audio/webm" }), "answer-1.webm");
    expect(text).toBe("Hello there");
    expect(mocks.callEdgeForm).toHaveBeenCalledWith("speechmatics-batch", expect.any(FormData));
    const file = (mocks.callEdgeForm.mock.calls[0][1] as FormData).get("audio") as File;
    expect(file.name).toBe("answer-1.wav");
    expect(file.type).toBe("audio/wav");
  });

  it("rethrows the edge function error with diagnostics logged", async () => {
    seedOfflineAudioContext(new Float32Array([0, 0.5]), new Float32Array([0, 0.5]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.callEdgeForm.mockRejectedValue(new Error("Speechmatics job creation failed (400)"));
    await expect(
      transcribeBlob(new Blob([new Uint8Array(500)], { type: "audio/webm" }), "answer-1.webm"),
    ).rejects.toThrow("Speechmatics job creation failed (400)");
    expect(warn).toHaveBeenCalled();
  });
});

// --- speakQuestion / stopQuestionAudio ------------------------------------
// The playback unit tests drive the module's real HTMLAudioElement handling.
// The edge function call (callEdgeAudio) and the browser Audio constructor are
// stubbed; everything else — play()/pause() semantics, AbortError on pause,
// event wiring, URL cleanup — is the real implementation under test.

function fakeAudio() {
  const paused = { current: false };
  const listeners: Record<string, (() => void)[]> = {};
  let settlePlay: { reject: (err: unknown) => void } | null = null;
  // play() stays pending until the test signals start (via the `playing`
  // event) or a stop pauses the element — mirroring a real <audio> element
  // whose play() settles only when playback actually begins or is aborted.
  const play = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        if (paused.current) {
          reject(new DOMException("The play() request was interrupted by a call to pause().", "AbortError"));
          return;
        }
        settlePlay = { reject };
      }),
  );
  const audio = {
    play,
    pause: vi.fn(() => {
      paused.current = true;
      settlePlay?.reject(new DOMException("The play() request was interrupted by a call to pause().", "AbortError"));
      settlePlay = null;
    }),
    addEventListener: vi.fn((type: string, cb: () => void) => {
      (listeners[type] ??= []).push(cb);
    }),
    removeEventListener: vi.fn(),
    error: null,
  };
  return { audio, listeners, play, paused };
}

function fire(listeners: Record<string, (() => void)[]>, type: string) {
  for (const cb of listeners[type] ?? []) cb();
}

function seedAudioGlobal(fake: ReturnType<typeof fakeAudio>) {
  // Must be a regular (constructible) function — vitest 4 mocks can't be
  // called with `new` when the implementation is an arrow function.
  vi.stubGlobal(
    "Audio",
    vi.fn(function (this: unknown) {
      return fake.audio as unknown as HTMLAudioElement;
    }) as unknown as typeof Audio,
  );
  vi.stubGlobal(
    "URL",
    Object.assign(Object.create(globalThis.URL), {
      createObjectURL: vi.fn(() => "blob:fake"),
      revokeObjectURL: vi.fn(),
    }),
  );
}

function stubCallEdgeAudio(blob: Blob) {
  mocks.callEdgeAudio.mockResolvedValue(blob);
}

const WAV_BLOB = new Blob(["RIFF"], { type: "audio/wav" });

describe("speakQuestion", () => {
  afterEach(() => {
    stopQuestionAudio();
  });

  it("plays the question and resolves with the element once playback starts", async () => {
    const fake = fakeAudio();
    seedAudioGlobal(fake);
    stubCallEdgeAudio(WAV_BLOB);
    const p = speakQuestion("Hello", "Sarah");
    // Wait until the TTS fetch resolved and the element is wired up, then
    // signal that playback started.
    await vi.waitFor(() => expect(fake.play).toHaveBeenCalledTimes(1));
    fire(fake.listeners, "playing");
    await expect(p).resolves.toBe(fake.audio);
    expect(fake.play).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).toHaveBeenCalledWith(WAV_BLOB);
    // The blob URL is released when playback ends, not leaked.
    fire(fake.listeners, "ended");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake");
  });

  it("returns null (not a failure) when the attempt was superseded by a stop", async () => {
    const fake = fakeAudio();
    seedAudioGlobal(fake);
    stubCallEdgeAudio(WAV_BLOB);
    const p = speakQuestion("Hello", "Sarah");
    // The stop must land after the element exists — otherwise it's a no-op.
    await vi.waitFor(() => expect(fake.play).toHaveBeenCalledTimes(1));
    stopQuestionAudio();
    await expect(p).resolves.toBeNull();
    expect(fake.play).toHaveBeenCalledTimes(1);
    // Superseded playback still releases the blob URL.
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake");
  });

  it("throws a real error carrying the underlying cause when playback fails", async () => {
    const fake = fakeAudio();
    fake.play.mockRejectedValueOnce(new Error("No audio output device"));
    seedAudioGlobal(fake);
    stubCallEdgeAudio(WAV_BLOB);
    await expect(speakQuestion("Hello", "Sarah")).rejects.toThrow(
      "Couldn't play the question audio — No audio output device",
    );
  });

  it("keeps the question playing when a stop is called for a previous element", async () => {
    const first = fakeAudio();
    const second = fakeAudio();
    seedAudioGlobal(first);
    stubCallEdgeAudio(WAV_BLOB);
    const p1 = speakQuestion("First", "Sarah");
    await vi.waitFor(() => expect(first.play).toHaveBeenCalledTimes(1));
    fire(first.listeners, "playing");
    await p1;
    // Re-point the Audio constructor at a second element, then stop only the first.
    seedAudioGlobal(second);
    stubCallEdgeAudio(WAV_BLOB);
    const p2 = speakQuestion("Second", "Sarah");
    await vi.waitFor(() => expect(second.play).toHaveBeenCalledTimes(1));
    fire(second.listeners, "playing");
    await p2;
    expect(second.play).toHaveBeenCalledTimes(1);
  });
});
