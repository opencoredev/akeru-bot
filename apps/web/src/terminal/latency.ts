/** Percentile and timing helpers used by the terminal latency harness. */
export interface TerminalLatencySample {
  readonly keypressToGlyphMs?: number;
  readonly byteArrivalToGlyphMs: number;
}
export interface TerminalLatencyPercentiles {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}
export function summarizeLatency(values: readonly number[]): TerminalLatencyPercentiles {
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
  };
}
export function summarizeTerminalLatency(samples: readonly TerminalLatencySample[]) {
  return {
    keypressToGlyph: summarizeLatency(
      samples.flatMap((s) => (s.keypressToGlyphMs === undefined ? [] : [s.keypressToGlyphMs])),
    ),
    byteArrivalToGlyph: summarizeLatency(samples.map((s) => s.byteArrivalToGlyphMs)),
  };
}
export function formatLatencyReport(
  label: string,
  samples: readonly TerminalLatencySample[],
): string {
  const summary = summarizeTerminalLatency(samples);
  const format = (value: TerminalLatencyPercentiles) =>
    `p50=${value.p50.toFixed(2)}ms p95=${value.p95.toFixed(2)}ms p99=${value.p99.toFixed(2)}ms n=${value.count}`;
  return [
    label,
    `keypress-to-glyph: ${format(summary.keypressToGlyph)}`,
    `byte-arrival-to-glyph: ${format(summary.byteArrivalToGlyph)}`,
  ].join("\n");
}

export interface TerminalLatencyProbe {
  readonly onKeypress?: (time: number, encodedInput: string) => void;
  readonly onByteArrival?: (time: number, output: string) => void;
  readonly onGlyphPaint?: (time: number) => void;
}
export interface TerminalLatencyCallbacks {
  readonly onKeypress: (encodedInput: string) => void;
  readonly onByteArrival: (output: string) => void;
  readonly onGlyphPaint: () => void;
}
const disabledCallbacks: TerminalLatencyCallbacks = {
  onKeypress: () => {},
  onByteArrival: () => {},
  onGlyphPaint: () => {},
};
export function terminalLatencyCallbacks(
  probe: TerminalLatencyProbe | undefined,
): TerminalLatencyCallbacks {
  if (probe === undefined) return disabledCallbacks;
  return {
    onKeypress: (encodedInput) => probe.onKeypress?.(performance.now(), encodedInput),
    onByteArrival: (output) => probe.onByteArrival?.(performance.now(), output),
    onGlyphPaint: () => probe.onGlyphPaint?.(performance.now()),
  };
}

const MAX_PENDING_KEYS = 128;
const MAX_PENDING_PAINTS = 128;
const MAX_SAMPLES = 512;
const ECHO_WINDOW_MS = 250;

/** Correlates printable key echoes while bounding all diagnostic state. */
export class TerminalLatencyRecorder implements TerminalLatencyProbe {
  private readonly pendingKeys: Array<{
    readonly keypressAt: number;
    readonly expected: string;
    byteAt?: number;
  }> = [];
  private readonly pendingPaints: Array<{ readonly keypressAt?: number; readonly byteAt: number }> =
    [];
  private readonly samplesBuffer: TerminalLatencySample[] = [];
  get samples(): readonly TerminalLatencySample[] {
    return this.samplesBuffer;
  }

  onKeypress(time: number, encodedInput: string): void {
    const expected =
      [...encodedInput].length === 1 && encodedInput >= " " && encodedInput <= "~"
        ? encodedInput
        : "";
    if (expected === "") return;
    if (this.pendingKeys.length >= MAX_PENDING_KEYS) this.pendingKeys.shift();
    this.pendingKeys.push({ keypressAt: time, expected });
  }
  onByteArrival(time: number, output: string): void {
    const printable = [...output].filter((char) => char >= " " && char <= "~");
    const eligible = this.pendingKeys.filter(
      (key) => key.byteAt === undefined && time - key.keypressAt <= ECHO_WINDOW_MS,
    );
    const candidates = eligible.filter(
      (key) =>
        eligible.filter((other) => other.expected === key.expected).length === 1 &&
        printable.filter((char) => char === key.expected).length === 1,
    );
    const positions = candidates.map((key) => printable.indexOf(key.expected));
    if (
      candidates.length > 0 &&
      positions.every((position, index) => index === 0 || position > positions[index - 1]!)
    ) {
      for (const key of candidates) key.byteAt = time;
    } else {
      if (this.pendingPaints.length >= MAX_PENDING_PAINTS) this.pendingPaints.shift();
      this.pendingPaints.push({ byteAt: time });
    }
  }
  onGlyphPaint(time: number): void {
    const key = this.pendingKeys.find((candidate) => candidate.byteAt !== undefined);
    if (key?.byteAt !== undefined) {
      if (this.pendingPaints.length >= MAX_PENDING_PAINTS) this.pendingPaints.shift();
      this.pendingPaints.push({ keypressAt: key.keypressAt, byteAt: key.byteAt });
      this.pendingKeys.splice(this.pendingKeys.indexOf(key), 1);
    }
    const pending = this.pendingPaints.shift();
    if (!pending) return;
    if (this.samplesBuffer.length >= MAX_SAMPLES) this.samplesBuffer.shift();
    this.samplesBuffer.push({
      byteArrivalToGlyphMs: Math.max(0, time - pending.byteAt),
      ...(pending.keypressAt === undefined
        ? {}
        : { keypressToGlyphMs: Math.max(0, time - pending.keypressAt) }),
    });
  }
  reset(): void {
    this.pendingKeys.length = 0;
    this.pendingPaints.length = 0;
    this.samplesBuffer.length = 0;
  }
  report(label = "terminal"): string {
    const result = formatLatencyReport(label, this.samplesBuffer);
    this.reset();
    return result;
  }
}
