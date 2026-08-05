/**
 * Raw PCM capture for Speechmatics realtime streaming.
 *
 * Why not MediaRecorder + decodeAudioData? Browsers cannot decode
 * WebM/Opus — the only format Chrome's MediaRecorder can emit — via
 * decodeAudioData; it throws "Unable to decode audio data". Instead we
 * capture raw Float32 samples with an AudioWorklet, convert them to
 * 16-bit little-endian PCM at 16 kHz (resampling if the browser ignores
 * the requested context sample rate) and hand each chunk straight to the
 * WebSocket. Lower latency, no encode/decode round-trip.
 */

const TARGET_RATE = 16000;
const FLUSH_SAMPLES = 4096; // ~256 ms of audio at 16 kHz

const WORKLET_SOURCE = `
class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / ${TARGET_RATE};
    this.acc = 0;
    this.buf = new Int16Array(0);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const ch = input[0];
    const n = ch.length;
    if (!n) return true;

    const resample = sampleRate !== ${TARGET_RATE};
    const outLen = resample
      ? Math.floor((n - 1 - this.acc) / this.ratio) + 1
      : n;

    if (outLen < 1) {
      if (resample) this.acc -= n;
      return true;
    }

    const pcm = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = resample ? this.acc + i * this.ratio : i;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, n - 1);
      const frac = pos - i0;
      const v = ch[i0] * (1 - frac) + ch[i1] * frac;
      const s = Math.max(-1, Math.min(1, v));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    if (resample) this.acc = this.acc + outLen * this.ratio - n;

    const merged = new Int16Array(this.buf.length + pcm.length);
    merged.set(this.buf);
    merged.set(pcm, this.buf.length);
    this.buf = merged;

    if (this.buf.length >= ${FLUSH_SAMPLES}) {
      this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
      this.buf = new Int16Array(0);
    }
    return true;
  }
}

registerProcessor('pcm-capture', PCMCaptureProcessor);
`;

/** A running PCM capture session. Call `stop()` to tear it down. */
export interface PcmCapture {
  stop(): void;
}

/**
 * Start capturing a MediaStream as 16 kHz S16LE PCM chunks, delivered to
 * `onData`. Resolves once the worklet is ready; rejects if the browser
 * cannot start the audio pipeline. Each call owns its own AudioContext —
 * call `capture.stop()` (or just let the session end) to release it.
 */
export async function startPcmCapture(
  stream: MediaStream,
  onData: (pcm16: ArrayBuffer) => void,
): Promise<PcmCapture> {
  const ctx = new AudioContext({ sampleRate: TARGET_RATE });
  try {
    await ctx.resume();

    const moduleUrl = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: "application/javascript" }),
    );
    try {
      await ctx.audioWorklet.addModule(moduleUrl);
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }

    const source = ctx.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(ctx, "pcm-capture");
    worklet.port.onmessage = (e: MessageEvent) => {
      const buf = e.data as ArrayBuffer;
      if (buf && buf.byteLength > 0) onData(buf);
    };

    // Zero-gain tail to the destination keeps process() firing in every
    // browser without echoing the mic through the speakers.
    const gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(worklet);
    worklet.connect(gain);
    gain.connect(ctx.destination);

    let stopped = false;
    return {
      stop() {
        if (stopped) return;
        stopped = true;
        worklet.port.onmessage = null;
        try {
          worklet.disconnect();
          source.disconnect();
          gain.disconnect();
        } catch {
          /* already torn down */
        }
        void ctx.close().catch(() => {});
      },
    };
  } catch (err) {
    void ctx.close().catch(() => {});
    throw err;
  }
}
