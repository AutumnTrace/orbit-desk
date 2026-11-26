import { describe, expect, it } from 'vitest';
import { downsample } from '../src/telemetry/downsample.ts';
import { SampleRing } from '../src/telemetry/ring.ts';

function ring(values: number[], { cadence = 250, skip = new Set<number>(), arrival = (i: number) => i * cadence } = {}): SampleRing {
  const r = new SampleRing(values.length + 8);
  values.forEach((v, i) => {
    if (!skip.has(i)) r.insert(i * cadence, v, 0, arrival(i), i);
  });
  return r;
}

const flat = (n: number, v = 26) => Array.from({ length: n }, () => v);

describe('downsampling', () => {
  it('keeps a one-sample dip at every zoom level', () => {
    // 9 minutes at 4 Hz, one sample at 23.9 among 26.0.
    const values = flat(2160);
    values[1033] = 23.9;
    const r = ring(values);
    for (const width of [40, 120, 333, 800, 1920, 4000]) {
      for (const [t0, t1] of [[0, 540_000], [200_000, 300_000], [258_000, 258_500]] as const) {
        const v = downsample(r, t0, t1, width, 375, Infinity);
        const ys = [...v.points].filter((_, i) => i % 2 === 1);
        expect(ys, `width ${width}, window ${t0}-${t1}`).toContain(Math.fround(23.9));
        expect(v.min).toBeCloseTo(23.9, 5);
      }
    }
  });

  it('keeps a one-sample spike too', () => {
    const values = flat(5000);
    values[2500] = 40;
    const v = downsample(ring(values), 0, 5000 * 250, 50, 375, Infinity);
    expect(v.max).toBe(40);
  });

  it('never invents a value: every point is a real sample, in time order', () => {
    const values = Array.from({ length: 3000 }, (_, i) => Math.fround(Math.sin(i / 37) * 10 + (i % 7)));
    const real = new Set(values);
    const v = downsample(ring(values), 0, 3000 * 250, 300, 375, Infinity);
    let prev = -Infinity;
    for (let i = 0; i < v.points.length; i += 2) {
      if (Number.isNaN(v.points[i]!)) continue;
      expect(real.has(v.points[i + 1]!)).toBe(true);
      expect(v.points[i]!).toBeGreaterThanOrEqual(prev);
      prev = v.points[i]!;
    }
    expect(v.points.length / 2).toBeLessThanOrEqual(4 * 300 + 2);
  });

  it('turns missing packets into a gap, not a zero', () => {
    const values = flat(400, 26);
    const missing = new Set(Array.from({ length: 40 }, (_, i) => 200 + i)); // 10 s of nothing
    const v = downsample(ring(values, { skip: missing }), 0, 100_000, 500, 375, Infinity);
    const ys = [...v.points].filter((_, i) => i % 2 === 1 && !Number.isNaN(v.points[i - 1]!));
    expect(ys.every((y) => y === 26)).toBe(true);
    expect(v.min).toBe(26);
    expect(v.gaps).toEqual([[199 * 250, 240 * 250]]);
    // The line is broken exactly once.
    expect([...v.points].filter((x, i) => i % 2 === 0 && Number.isNaN(x))).toHaveLength(1);
  });

  it('treats a sample that has not arrived yet as missing', () => {
    // Sample 100 arrives 3 s late.
    const values = flat(200);
    const r = ring(values, { arrival: (i) => (i === 100 ? i * 250 + 3000 : i * 250) });
    const before = downsample(r, 0, 50_000, 400, 375, 26_000);
    expect(before.gaps).toEqual([[99 * 250, 101 * 250]]);
    const after = downsample(r, 0, 50_000, 400, 375, 30_000);
    expect(after.gaps).toEqual([]);
  });
});

describe('the ring buffer', () => {
  it('keeps the newest samples in time order and a fixed size', () => {
    const r = new SampleRing(100);
    const bytes = r.bytes;
    for (let i = 0; i < 1000; i++) r.insert(i, i, 0, i, i);
    expect(r.length).toBe(100);
    expect(r.metAt(0)).toBe(900);
    expect(r.metAt(99)).toBe(999);
    expect(r.dropped).toBe(900);
    expect(r.bytes).toBe(bytes);
  });

  it('puts a delayed sample in its place, across the wrap point', () => {
    const r = new SampleRing(8);
    for (const met of [0, 1, 2, 3, 4, 5, 6, 8, 9, 10]) r.insert(met * 100, met, 0, met, met);
    r.insert(700, 7, 0, 99, 7); // late
    const order = Array.from({ length: r.length }, (_, i) => r.metAt(i));
    expect(order).toEqual([300, 400, 500, 600, 700, 800, 900, 1000]);
  });

  it('drops a delayed sample older than everything it keeps', () => {
    const r = new SampleRing(4);
    for (let i = 10; i < 14; i++) r.insert(i, i, 0, i, i);
    r.insert(1, 1, 0, 20, 1);
    expect(Array.from({ length: 4 }, (_, i) => r.metAt(i))).toEqual([10, 11, 12, 13]);
  });
});
