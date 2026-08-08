import { afterEach, describe, expect, it, vi } from "vitest";
import { SUPABASE_URL, callEdge, callEdgeAudio, callEdgeForm, getAccessToken, sleep } from "../../lib/config";

// Mock global fetch — callEdge/callEdgeForm/callEdgeAudio all go through it.
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  fetchMock.mockReset();
});

describe("callEdge", () => {
  it("POSTs JSON to the edge function URL", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    const data = await callEdge<{ status: string }>("ai-brief", { url: "x" });
    expect(data).toEqual({ status: "ok" });
    expect(fetchMock).toHaveBeenCalledWith(
      `${SUPABASE_URL}/functions/v1/ai-brief`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
        body: JSON.stringify({ url: "x" }),
      }),
    );
  });

  it("sends no body when none is given", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    await callEdge("ai-brief");
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  });

  it("throws a message from the error field on non-ok responses", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "Bad secret" }), { status: 401 }));
    await expect(callEdge("ai-brief")).rejects.toThrow("Bad secret");
  });

  it("throws a default message when the body is not JSON", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(callEdge("ai-brief")).rejects.toThrow(/ai-brief failed/);
  });
});

describe("callEdgeForm", () => {
  it("sends the FormData body without a Content-Type header", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ transcript: "hi" }), { status: 200 }));
    const form = new FormData();
    form.append("audio", new Blob(["x"]), "a.webm");
    const data = await callEdgeForm<{ transcript: string }>("speechmatics-batch", form);
    expect(data.transcript).toBe("hi");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(form);
    // No explicit Content-Type — the browser must set the multipart boundary.
    expect(init.headers["Content-Type"]).toBeUndefined();
  });
});

describe("callEdgeAudio", () => {
  it("returns the response as a blob", async () => {
    // jsdom's Blob and Node's Response come from different realms, and Response
    // stringifies a jsdom Blob body as "[object Blob]". Pass a string body and
    // assert the blob produced by res.blob() carries its bytes.
    fetchMock.mockResolvedValue(new Response("audio-bytes", { status: 200 }));
    const blob = await callEdgeAudio("speechmatics-tts", { text: "hi", voice: "sarah" });
    expect(blob).toBeDefined();
    expect(blob.size).toBe(11); // "audio-bytes".length
  });
});

describe("getAccessToken / sleep", () => {
  it("getAccessToken returns null before any session", () => {
    expect(getAccessToken()).toBeNull();
  });

  it("sleep resolves after the requested delay", async () => {
    const start = Date.now();
    await sleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});
