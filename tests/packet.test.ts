import { describe, expect, it } from 'vitest';
import { crc16 } from '../src/telemetry/crc16.ts';
import { Engine } from '../src/telemetry/engine.ts';
import { decodePacket, encodePacket, type Packet } from '../src/telemetry/packet.ts';
import { readRecording, writeRecording } from '../src/telemetry/recording.ts';

const packet: Packet = {
  version: 1,
  flags: 0,
  source: 1,
  seq: 1039,
  met: 259_750,
  samples: [
    { channel: 101, value: 24.91, quality: 0 },
    { channel: 102, value: -9.62, quality: 0 },
  ],
};

describe('crc16', () => {
  it('is CRC-16/CCITT-FALSE', () => {
    expect(crc16(new TextEncoder().encode('123456789'))).toBe(0x29b1);
  });
});

describe('packets', () => {
  it('round-trip, with float32 precision', () => {
    const bytes = encodePacket(packet);
    expect(bytes.length).toBe(16 + 2 * 7 + 2);
    const decoded = decodePacket(bytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.packet.seq).toBe(1039);
    expect(decoded.packet.met).toBe(259_750);
    expect(decoded.packet.samples[0]!.value).toBeCloseTo(24.91, 5);
  });

  it('lays out the header as documented', () => {
    const b = encodePacket(packet);
    expect([...b.subarray(0, 16)]).toEqual([0x44, 0x4f, 1, 0, 1, 0, 0x0f, 0x04, 0xa6, 0xf6, 0x03, 0x00, 14, 0, 2, 0]);
  });

  // Each malformed fixture fails as itself, and says why.
  const good = encodePacket(packet);
  const mutate = (f: (b: Uint8Array) => Uint8Array) => f(good.slice());
  const fixtures: [string, Uint8Array][] = [
    ['truncated', good.slice(0, 11)],
    ['truncated', good.slice(0, good.length - 3)],
    ['bad-magic', mutate((b) => ((b[0] = 0xff), b))],
    ['unsupported-version', mutate((b) => ((b[2] = 2), b))],
    ['length-mismatch', mutate((b) => ((b[12] = 15), b))],
    ['length-mismatch', new Uint8Array([...good, 0, 0])],
    ['crc-mismatch', mutate((b) => ((b[20] = b[20]! ^ 0x10), b))],
    ['unknown-source', reCrc(mutate((b) => ((b[4] = 9), b)))],
    ['unknown-channel', reCrc(mutate((b) => ((b[16] = 201 & 0xff), b)))],
    ['bad-quality', reCrc(mutate((b) => ((b[22] = 7), b)))],
    ['not-finite', reCrc(mutate((b) => (new DataView(b.buffer).setFloat32(18, NaN, true), b)))],
  ];
  it.each(fixtures)('rejects %s', (kind, bytes) => {
    const decoded = decodePacket(bytes);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.error).toBe(kind);
  });

  it('an invalid packet costs only itself: decoding carries on with the next one', () => {
    const records = [0, 1, 2, 3].map((i) => ({ arrival: i * 250 + 100, bytes: encodePacket({ ...packet, seq: i, met: i * 250 }) }));
    records.splice(2, 0, { arrival: 400, bytes: fixtures[6]![1] }, { arrival: 401, bytes: fixtures[0]![1] });
    const engine = Engine.fromRecording(writeRecording(meta(), records));
    const stats = engine.statsAt(10_000);
    expect(stats.packets).toBe(4);
    expect(stats.invalid).toBe(2);
    expect(stats.invalidByKind).toEqual({ 'crc-mismatch': 1, truncated: 1 });
    expect(engine.valueAt(101, 10_000).met).toBe(750);
  });
});

describe('recordings', () => {
  it('keep arrival order and survive a cut-off final record', () => {
    const records = [3, 1, 2].map((i) => ({ arrival: i * 10, bytes: encodePacket({ ...packet, seq: i }) }));
    const file = writeRecording(meta(), records);
    const read = readRecording(file.subarray(0, file.length - 5));
    expect(read.meta.id).toBe('test');
    expect(read.records.map((r) => r.arrival)).toEqual([30, 10]);
  });
});

function reCrc(b: Uint8Array): Uint8Array {
  const end = b.length - 2;
  new DataView(b.buffer).setUint16(end, crc16(b, 0, end), true);
  return b;
}

function meta() {
  return { id: 'test', title: 'test', spacecraft: 'test', description: '', durationMs: 10_000, seed: 1, notes: [] };
}
