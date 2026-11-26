import { CHANNEL_BY_ID, type Source, SOURCES } from './channels.ts';
import { crc16 } from './crc16.ts';

// Packet format, version 1. Little-endian. One packet = one source at one mission time.
//
//   offset  size  field
//   0       2     magic 0x4F44 ("OD" read as little-endian u16: bytes 44 4F)
//   2       1     version = 1
//   3       1     flags: bit 0 = retransmitted (sent again after a loss of signal)
//   4       2     source: 1 EPS, 2 COMMS, 3 ADCS
//   6       2     sequence number, per source, wraps at 65536
//   8       4     mission elapsed time, milliseconds
//   12      2     payload length in bytes (= 7 × sample count)
//   14      1     sample count
//   15      1     reserved, 0
//   16      7×n   samples: channel id u16, value f32, quality u8 (0 good, 1 suspect, 2 bad)
//   16+7n   2     CRC-16/CCITT-FALSE over bytes 0 .. 16+7n-1
//
// Live (one WebSocket message per packet) and recorded (see recording.ts) data go through the
// same decodePacket. Anything wrong with a packet yields a typed error for that packet only.

export const MAGIC = 0x4f44;
export const VERSION = 1;
export const HEADER_BYTES = 16;
export const SAMPLE_BYTES = 7;
export const CRC_BYTES = 2;
export const FLAG_RETRANSMITTED = 1;

export const QUALITY_NAMES = ['good', 'suspect', 'bad'] as const;
export type Quality = 0 | 1 | 2;

export interface Sample {
  channel: number;
  value: number;
  quality: Quality;
}

export interface Packet {
  version: number;
  flags: number;
  source: Source;
  seq: number;
  met: number;
  samples: Sample[];
}

export type DecodeErrorKind =
  | 'truncated'
  | 'bad-magic'
  | 'unsupported-version'
  | 'length-mismatch'
  | 'crc-mismatch'
  | 'unknown-source'
  | 'unknown-channel'
  | 'bad-quality'
  | 'not-finite';

export type Decoded = { ok: true; packet: Packet } | { ok: false; error: DecodeErrorKind; detail: string };

export function encodePacket(packet: Packet): Uint8Array {
  const n = packet.samples.length;
  const bytes = new Uint8Array(HEADER_BYTES + n * SAMPLE_BYTES + CRC_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, MAGIC, true);
  view.setUint8(2, packet.version);
  view.setUint8(3, packet.flags);
  view.setUint16(4, packet.source, true);
  view.setUint16(6, packet.seq & 0xffff, true);
  view.setUint32(8, packet.met, true);
  view.setUint16(12, n * SAMPLE_BYTES, true);
  view.setUint8(14, n);
  view.setUint8(15, 0);
  packet.samples.forEach((s, i) => {
    const at = HEADER_BYTES + i * SAMPLE_BYTES;
    view.setUint16(at, s.channel, true);
    view.setFloat32(at + 2, s.value, true);
    view.setUint8(at + 6, s.quality);
  });
  view.setUint16(HEADER_BYTES + n * SAMPLE_BYTES, crc16(bytes, 0, HEADER_BYTES + n * SAMPLE_BYTES), true);
  return bytes;
}

export function decodePacket(bytes: Uint8Array): Decoded {
  const fail = (error: DecodeErrorKind, detail: string): Decoded => ({ ok: false, error, detail });
  if (bytes.length < HEADER_BYTES + CRC_BYTES) return fail('truncated', `${bytes.length} bytes, header needs ${HEADER_BYTES + CRC_BYTES}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint16(0, true);
  if (magic !== MAGIC) return fail('bad-magic', `0x${magic.toString(16).padStart(4, '0')}`);
  const version = view.getUint8(2);
  if (version !== VERSION) return fail('unsupported-version', `version ${version}`);
  const payload = view.getUint16(12, true);
  const count = view.getUint8(14);
  if (payload !== count * SAMPLE_BYTES) return fail('length-mismatch', `payload ${payload} bytes for ${count} samples`);
  if (bytes.length !== HEADER_BYTES + payload + CRC_BYTES) {
    return fail(bytes.length < HEADER_BYTES + payload + CRC_BYTES ? 'truncated' : 'length-mismatch',
      `${bytes.length} bytes, header says ${HEADER_BYTES + payload + CRC_BYTES}`);
  }
  const expected = view.getUint16(HEADER_BYTES + payload, true);
  const actual = crc16(bytes, 0, HEADER_BYTES + payload);
  if (expected !== actual) return fail('crc-mismatch', `stored 0x${hex4(expected)}, computed 0x${hex4(actual)}`);
  const source = view.getUint16(4, true);
  if (!(source in SOURCES)) return fail('unknown-source', `source ${source}`);

  const samples: Sample[] = [];
  for (let i = 0; i < count; i++) {
    const at = HEADER_BYTES + i * SAMPLE_BYTES;
    const channel = view.getUint16(at, true);
    const def = CHANNEL_BY_ID.get(channel);
    if (!def || def.source !== source) return fail('unknown-channel', `channel ${channel} in source ${source}`);
    const value = view.getFloat32(at + 2, true);
    if (!Number.isFinite(value)) return fail('not-finite', `channel ${channel} = ${value}`);
    const quality = view.getUint8(at + 6);
    if (quality > 2) return fail('bad-quality', `quality ${quality}`);
    samples.push({ channel, value, quality: quality as Quality });
  }
  return {
    ok: true,
    packet: { version, flags: view.getUint8(3), source: source as Source, seq: view.getUint16(6, true), met: view.getUint32(8, true), samples },
  };
}

const hex4 = (n: number) => n.toString(16).padStart(4, '0');
