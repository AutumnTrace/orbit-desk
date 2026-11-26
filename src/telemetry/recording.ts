// A recorded mission: the packets in the order they arrived, each with its arrival time.
//
//   offset  size  field
//   0       8     "ODREC001"
//   8       4     metadata length L, u32 little-endian
//   12      L     metadata, UTF-8 JSON (MissionMeta)
//   12+L    ...   records: arrival MET u32 (ms) · packet length u16 · packet bytes
//
// The record length frames each packet, so a corrupt packet costs exactly that packet: the reader
// moves on to the next record. Arrival time is kept because it is not the packet's own mission
// time: a delayed packet arrives after packets with later mission times.

export interface MissionMeta {
  id: string;
  title: string;
  spacecraft: string;
  description: string;
  durationMs: number;
  seed: number;
  // Interesting moments, for the mission picker and the README. Not used by the decoder.
  notes: { met: number; text: string }[];
}

export interface RecordEntry {
  arrival: number;
  bytes: Uint8Array;
}

const MAGIC = 'ODREC001';

export function writeRecording(meta: MissionMeta, records: RecordEntry[]): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const size = 12 + json.length + records.reduce((n, r) => n + 6 + r.bytes.length, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode(MAGIC), 0);
  view.setUint32(8, json.length, true);
  out.set(json, 12);
  let at = 12 + json.length;
  for (const r of records) {
    view.setUint32(at, r.arrival, true);
    view.setUint16(at + 4, r.bytes.length, true);
    out.set(r.bytes, at + 6);
    at += 6 + r.bytes.length;
  }
  return out;
}

export function readRecording(data: Uint8Array): { meta: MissionMeta; records: RecordEntry[] } {
  if (new TextDecoder().decode(data.subarray(0, 8)) !== MAGIC) throw new Error('not an orbit-desk recording');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const metaLength = view.getUint32(8, true);
  const meta = JSON.parse(new TextDecoder().decode(data.subarray(12, 12 + metaLength))) as MissionMeta;
  const records: RecordEntry[] = [];
  let at = 12 + metaLength;
  while (at + 6 <= data.length) {
    const arrival = view.getUint32(at, true);
    const length = view.getUint16(at + 4, true);
    if (at + 6 + length > data.length) break; // a cut-off final record
    records.push({ arrival, bytes: data.subarray(at + 6, at + 6 + length) });
    at += 6 + length;
  }
  return { meta, records };
}
