import { afterEach, describe, expect, it, vi } from "vitest";
import { extFor, pickMimeType } from "../../lib/audio";

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
