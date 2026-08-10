import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import RehearseScreen from "../../components/RehearseScreen";
import { makeDossier } from "../helpers/fixtures";

// The screen imports ai (generateAiQuestions, scoreWithAi), audio
// (pickMimeType, transcribeBlob, ...), score (pure), config (callEdge...).
// Mock the network/audio-touching modules; scoreAnswer stays real.
// vi.hoisted: factories are hoisted above consts, so the mock fns must be
// created with vi.hoisted to avoid TDZ errors.
const mocks = vi.hoisted(() => ({
  generateAiQuestions: vi.fn().mockResolvedValue(null),
  scoreWithAi: vi.fn().mockResolvedValue(null),
  pickMimeType: vi.fn().mockReturnValue(null), // voice unsupported
  transcribeBlob: vi.fn(),
  speakQuestion: vi.fn(),
  stopQuestionAudio: vi.fn(),
}));

vi.mock("../../lib/ai", () => ({
  generateAiQuestions: (...args: unknown[]) => mocks.generateAiQuestions(...args),
  scoreWithAi: (...args: unknown[]) => mocks.scoreWithAi(...args),
}));

vi.mock("../../lib/audio", () => ({
  pickMimeType: (...args: unknown[]) => mocks.pickMimeType(...args),
  transcribeBlob: (...args: unknown[]) => mocks.transcribeBlob(...args),
  speakQuestion: (...args: unknown[]) => mocks.speakQuestion(...args),
  stopQuestionAudio: (...args: unknown[]) => mocks.stopQuestionAudio(...args),
  extFor: () => "webm",
}));

const baseProps = {
  dossiers: [] as ReturnType<typeof makeDossier>[],
  onSessionComplete: vi.fn(),
  goResearch: vi.fn(),
  onRunningChange: vi.fn(),
  headingId: "main-heading-rehearse",
  mode: "text" as const,
  onModeChange: vi.fn(),
  voiceUnsupported: true,
  resumeText: null,
};

/** Minimal MediaRecorder fake — records chunks, fires `stop` via
 *  addEventListener (the API the component actually uses), and exposes
 *  helpers to emit data and fire stop. */
function installMediaRecorder() {
  const listeners: Record<string, Array<() => void>> = {};

  class FakeMediaRecorder {
    state = "inactive";
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    stream: MediaStream;
    opts: { mimeType?: string };
    constructor(stream: MediaStream, opts: { mimeType?: string }) {
      this.stream = stream;
      this.opts = opts;
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      queueMicrotask(() => {
        for (const cb of listeners["stop"] ?? []) cb();
        this.onstop?.();
      });
    }
    addEventListener(type: string, cb: () => void) {
      (listeners[type] ??= []).push(cb);
    }
    removeEventListener() {}
  }

  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal(
    "navigator",
    Object.assign({}, navigator, {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) },
    }),
  );

  const rec = new FakeMediaRecorder({} as MediaStream, {});
  return {
    rec,
    /** Push a chunk into the recorder's data stream (simulates a live mic). */
    emitData: (chunk: Blob) => rec.ondataavailable?.({ data: chunk }),
    /** Fire the stop event the component awaits (the browser does this after
     *  rec.stop()). */
    fireStop: () => {
      for (const cb of listeners["stop"] ?? []) cb();
      rec.onstop?.();
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RehearseScreen", () => {
  it("renders the empty state with a Go to Research CTA when there are no dossiers", () => {
    render(<RehearseScreen {...baseProps} />);
    expect(screen.getByRole("heading", { name: "Rehearse" })).toBeInTheDocument();
    expect(screen.getByText("Nothing to rehearse yet")).toBeInTheDocument();
    const cta = screen.getByRole("button", { name: /go to research/i });
    expect(cta).toBeInTheDocument();
  });

  it("lists a dossier as a selectable job when one exists", () => {
    render(<RehearseScreen {...baseProps} dossiers={[makeDossier()]} />);
    expect(screen.getByText("Senior Engineer")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /begin interview/i })).toBeInTheDocument();
  });

  it("offers retry / type-instead / record-again when transcription fails, and Skip stays usable", async () => {
    const user = userEvent.setup();
    // Voice supported: pickMimeType returns webm.
    mocks.pickMimeType.mockReturnValue("audio/webm");
    // Transcription fails — the dead-end that used to freeze the interview.
    mocks.transcribeBlob.mockRejectedValue(new Error("Speechmatics job creation failed (400)"));
    const { emitData } = installMediaRecorder();
    render(
      <RehearseScreen
        {...baseProps}
        dossiers={[makeDossier()]}
        mode="voice"
        voiceUnsupported={false}
      />,
    );

    // Select the job and begin.
    await user.click(screen.getByRole("button", { name: /senior engineer/i }));
    await user.click(screen.getByRole("button", { name: /begin interview/i }));

    // Record then stop (the Stop button drives rec.stop() → the stop event).
    const record = await screen.findByRole("button", { name: /start recording/i });
    await user.click(record);
    emitData(new Blob([new Uint8Array(500)], { type: "audio/webm" }));
    await user.click(screen.getByRole("button", { name: /stop recording/i }));

    // The three recovery actions appear; none of them is dead.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /retry transcription/i })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /type instead/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /record again/i })).toBeInTheDocument();
    // Skip is NOT disabled by the failure — the escape hatch always works.
    expect(screen.getByRole("button", { name: /^skip$/i })).not.toBeDisabled();

    // Retry re-uploads the same blob; this time it succeeds.
    mocks.transcribeBlob.mockResolvedValueOnce("A fine answer");
    await user.click(screen.getByRole("button", { name: /retry transcription/i }));
    await waitFor(() => expect(mocks.transcribeBlob).toHaveBeenCalledTimes(2));
    // The answer is committed — Next question is now enabled.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /next question/i })).not.toBeDisabled();
    });
    // The failure panel is gone.
    expect(screen.queryByRole("button", { name: /retry transcription/i })).not.toBeInTheDocument();
  });

  it("lets the candidate type the answer instead after a failed transcription", async () => {
    const user = userEvent.setup();
    mocks.pickMimeType.mockReturnValue("audio/webm");
    mocks.transcribeBlob.mockRejectedValue(new Error("boom"));
    const { emitData } = installMediaRecorder();
    render(
      <RehearseScreen
        {...baseProps}
        dossiers={[makeDossier()]}
        mode="voice"
        voiceUnsupported={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: /senior engineer/i }));
    await user.click(screen.getByRole("button", { name: /begin interview/i }));

    await user.click(await screen.findByRole("button", { name: /start recording/i }));
    emitData(new Blob([new Uint8Array(500)], { type: "audio/webm" }));
    await user.click(screen.getByRole("button", { name: /stop recording/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /type instead/i })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /type instead/i }));
    // The failure panel yields to the answer box — no stray retry button.
    expect(screen.queryByRole("button", { name: /retry transcription/i })).not.toBeInTheDocument();
    // The text box appears; commit routes through commitText (scored).
    const textarea = await screen.findByPlaceholderText(/type your answer instead/i);
    await user.type(textarea, "I answered by typing.");
    await user.click(screen.getByRole("button", { name: /next question/i }));
    // commitText pushes the answer and advances — the next question renders.
    await waitFor(() => expect(screen.getByRole("button", { name: /start recording/i })).toBeInTheDocument());
  });

  it("lets the candidate record again after a failed transcription", async () => {
    const user = userEvent.setup();
    mocks.pickMimeType.mockReturnValue("audio/webm");
    mocks.transcribeBlob.mockRejectedValue(new Error("boom"));
    const { emitData } = installMediaRecorder();
    render(
      <RehearseScreen
        {...baseProps}
        dossiers={[makeDossier()]}
        mode="voice"
        voiceUnsupported={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: /senior engineer/i }));
    await user.click(screen.getByRole("button", { name: /begin interview/i }));

    await user.click(await screen.findByRole("button", { name: /start recording/i }));
    emitData(new Blob([new Uint8Array(500)], { type: "audio/webm" }));
    await user.click(screen.getByRole("button", { name: /stop recording/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /record again/i })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /record again/i }));
    // The recorder re-arms for the same question — the record button is live
    // again (recording=true), so it reads "Stop recording".
    await waitFor(() => expect(screen.getByRole("button", { name: /stop recording/i })).toBeInTheDocument());
  });

  it("Skip always works while a transcription is in flight, and the late result is discarded", async () => {
    const user = userEvent.setup();
    mocks.pickMimeType.mockReturnValue("audio/webm");
    // The transcription stays pending until the test releases it — this is
    // the window where every control used to be disabled at once.
    let releaseTranscription: (v: string) => void = () => {};
    const pending = new Promise<string>((resolve) => {
      releaseTranscription = resolve;
    });
    mocks.transcribeBlob.mockReturnValue(pending);
    const { emitData } = installMediaRecorder();
    render(
      <RehearseScreen
        {...baseProps}
        dossiers={[makeDossier()]}
        mode="voice"
        voiceUnsupported={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: /senior engineer/i }));
    await user.click(screen.getByRole("button", { name: /begin interview/i }));

    await user.click(await screen.findByRole("button", { name: /start recording/i }));
    emitData(new Blob([new Uint8Array(500)], { type: "audio/webm" }));
    await user.click(screen.getByRole("button", { name: /stop recording/i }));

    // Transcription is in flight — the escape hatch must NOT be gated.
    await waitFor(() => expect(screen.getByText("transcribing…")).toBeInTheDocument());
    const skip = screen.getByRole("button", { name: /^skip$/i });
    expect(skip).not.toBeDisabled();

    // Skip mid-transcription — moves on and discards the in-flight result.
    await user.click(skip);
    await waitFor(() => expect(screen.getByText("2 / 8")).toBeInTheDocument());
    // The new question is ready to record — it never inherits "transcribing…".
    expect(screen.getByText("tap to record")).toBeInTheDocument();

    // The abandoned transcription finally resolves — it must not surface on
    // the question the candidate moved to: no failure panel, no transcript.
    releaseTranscription("I answered this.");
    await waitFor(() => expect(mocks.transcribeBlob).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: /retry transcription/i })).not.toBeInTheDocument();
    expect(screen.queryByText("I answered this.")).not.toBeInTheDocument();
    // And the answer was NOT pushed for the question the candidate skipped —
    // the skip already recorded a skipped answer for it.
    expect(screen.getByText("tap to record")).toBeInTheDocument();
  });
});
