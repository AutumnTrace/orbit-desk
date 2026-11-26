import type { SampleRing } from './ring.ts';

// Reduce a window of samples to what a canvas of `width` pixels can show, without losing the
// signal. Per pixel column keep the first, the lowest, the highest and the last sample, in time
// order (the M4 idea), so a one-sample dip or spike still reaches the screen however far out you
// zoom. Every output point is a real sample: nothing is averaged or interpolated.
//
// A gap (consecutive samples further apart than maxGapMs, or a sample that has not arrived by
// `arrivedBy`) becomes a NaN break, so the line stops instead of bridging missing data, and is
// reported in `gaps` (interior gaps only: the region after the last arrived sample is simply
// empty). Missing data is never drawn as a value, zero or otherwise.

export interface View {
  // Pairs of (met, value); a NaN pair breaks the line.
  points: Float64Array;
  min: number;
  max: number;
  minAt: number;
  maxAt: number;
  count: number; // samples inside [t0, t1] that had arrived
  gaps: [number, number][];
}

export function downsample(ring: SampleRing, t0: number, t1: number, width: number, maxGapMs: number, arrivedBy: number): View {
  const out: number[] = [];
  const gaps: [number, number][] = [];
  let min = Infinity;
  let max = -Infinity;
  let minAt = NaN;
  let maxAt = NaN;
  let count = 0;

  const columns = Math.max(1, Math.floor(width));
  const span = Math.max(1, t1 - t0);
  // One sample beyond each edge, so the line runs to the edge of the plot.
  let i = Math.max(0, ring.lowerBound(t0) - 1);
  let end = Math.min(ring.length, ring.lowerBound(t1) + 1);
  while (end < ring.length && ring.arrival[ring.slot(end - 1)]! > arrivedBy) end++;

  let bucket = -1;
  let first = -1;
  let last = -1;
  let lo = -1;
  let hi = -1;
  let prevMet = NaN;

  const flush = () => {
    if (first < 0) return;
    const picks = [first, lo, hi, last].filter((v, k, all) => all.indexOf(v) === k).sort((a, b) => a - b);
    for (const p of picks) out.push(ring.met[ring.slot(p)]!, ring.value[ring.slot(p)]!);
    first = last = lo = hi = -1;
  };

  for (; i < end; i++) {
    const s = ring.slot(i);
    if (ring.arrival[s]! > arrivedBy) continue;
    const met = ring.met[s]!;
    const value = ring.value[s]!;
    if (!Number.isNaN(prevMet) && met - prevMet > maxGapMs) {
      flush();
      out.push(NaN, NaN);
      gaps.push([prevMet, met]);
      bucket = -1;
    }
    prevMet = met;
    if (met >= t0 && met <= t1) {
      count++;
      if (value < min) {
        min = value;
        minAt = met;
      }
      if (value > max) {
        max = value;
        maxAt = met;
      }
    }
    const b = Math.min(columns - 1, Math.max(-1, Math.floor(((met - t0) / span) * columns)));
    if (b !== bucket) {
      flush();
      bucket = b;
    }
    if (first < 0) first = lo = hi = i;
    last = i;
    if (value < ring.value[ring.slot(lo)]!) lo = i;
    if (value > ring.value[ring.slot(hi)]!) hi = i;
  }
  flush();
  return { points: Float64Array.from(out), min, max, minAt, maxAt, count, gaps };
}
