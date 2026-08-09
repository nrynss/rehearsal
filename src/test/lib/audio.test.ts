import { afterEach, describe, expect, it, vi } from "vitest";
import { extFor, pickMimeType, speakQuestion, stopQuestionAudio } from "../../lib/audio";

// callEdgeAudio is module-mocked below so speakQuestion never hits the
// network during unit tests. (A vi.spyOn on a throwaway object would not
// intercept the module binding audio.ts actually imports.)
const mocks = vi.hoisted(() => ({ callEdgeAudio: vi.fn() }));

vi.mock("../../lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/config")>();
  return { ...actual, callEdgeAudio: mocks.callEdgeAudio };
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
