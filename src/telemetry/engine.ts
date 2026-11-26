import { type Alarm, ALARM_CHANNELS, limitAlarms, lossOfSignal } from './alarms.ts';
import { CHANNEL_BY_ID, CHANNELS, type ChannelDef, channelsOf, type Source, SOURCES } from './channels.ts';
import { downsample } from './downsample.ts';
import { type DecodeErrorKind, decodePacket, HEADER_BYTES, SAMPLE_BYTES } from './packet.ts';
import { readRecording, type MissionMeta } from './recording.ts';
import { SampleRing } from './ring.ts';

// Everything the screen shows, computed from the packets that had arrived by the playhead.
// The engine keeps no playback state: query(t) is a function of the data and t alone, so seeking
// to t and playing up to t give the same answer. It runs in the Web Worker (see worker/) and,
// unchanged, in the tests.

export interface PacketEntry {
  id: number;
  source: Source;
  seq: number;
  met: number;
  arrival: number;
  flags: number;
  bytes: Uint8Array;
}

export interface Query {
  t: number;
  span: number;
  width: number;
  channels: number[];
  source: Source;
  inspect: number | null; // packet id, or null for the packet of `source` at the playhead
}

export interface ChannelValue {
  channel: number;
  value: number | null;
  met: number | null;
  quality: number | null;
}

export interface ChannelView {
  channel: number;
  points: Float64Array;
  min: number;
  max: number;
  count: number;
  gaps: [number, number][];
}

export type IntervalRow =
  | { kind: 'packet'; id: number; met: number; seq: number; arrival: number; flags: number; values: (number | null)[]; quality: number[] }
  | { kind: 'gap'; from: number; to: number; missing: number; open: boolean };

export interface Inspection {
  id: number;
  source: Source;
  sourceName: string;
  version: number;
  flags: number;
  seq: number;
  met: number;
  arrival: number;
  length: number;
  samples: { channel: number; key: string; name: string; value: number; unit: string; decimals: number; quality: number }[];
  bytes: number[];
  fields: { name: string; offset: number; size: number; value: string }[];
}

export interface Stats {
  packets: number;
  invalid: number;
  invalidByKind: Partial<Record<DecodeErrorKind, number>>;
  missing: number;
  retransmitted: number;
  duplicates: number;
  bufferSamples: number;
  bufferCapacity: number;
  bufferBytes: number;
  dropped: number;
}

export interface QueryResult {
  t: number;
  window: [number, number];
  source: Source; // of the interval rows and the inspection
  width: number; // pixel columns the views were reduced to
  values: ChannelValue[];
  views: ChannelView[];
  alarms: (Alarm & { active: boolean })[];
  stats: Stats;
  interval: IntervalRow[];
  intervalTotal: number; // rows in the whole window; interval holds at most MAX_ROWS of them
  inspection: Inspection | null;
}

// Rows sent for the table: the ones nearest the playhead. A ten-minute window holds thousands.
export const MAX_ROWS = 200;

interface Invalid {
  arrival: number;
  error: DecodeErrorKind;
  detail: string;
}

export class Engine {
  meta: MissionMeta | null = null;
  readonly rings = new Map<number, SampleRing>();
  private readonly logs = new Map<Source, PacketEntry[]>();
  private readonly byId = new Map<number, PacketEntry>();
  private readonly invalid: Invalid[] = [];
  private readonly logCapacity: number;
  private nextId = 1;
  private duplicates = 0;
  private latestArrival = 0;
  private alarmCache: Alarm[] | null = null;

  readonly historyMs: number;

  // historyMs bounds memory (live mode); Infinity keeps everything (recorded missions).
  constructor(historyMs: number, expectedDurationMs = historyMs) {
    this.historyMs = historyMs;
    const keep = Number.isFinite(historyMs) ? historyMs : expectedDurationMs;
    for (const c of CHANNELS) {
      this.rings.set(c.id, new SampleRing(Math.ceil((keep / SOURCES[c.source].cadenceMs) * 1.25) + 64));
    }
    this.logCapacity = Math.ceil((keep / SOURCES[1].cadenceMs) * 1.25) + 64;
    for (const s of Object.keys(SOURCES)) this.logs.set(Number(s) as Source, []);
  }

  static fromRecording(data: Uint8Array): Engine {
    const { meta, records } = readRecording(data);
    const engine = new Engine(Infinity, meta.durationMs + 60_000);
    engine.meta = meta;
    for (const r of records) engine.receive(r.arrival, r.bytes);
    return engine;
  }

  // One framed packet, live or recorded: decode, and on failure count it and carry on.
  receive(arrival: number, bytes: Uint8Array): void {
    this.latestArrival = Math.max(this.latestArrival, arrival);
    const decoded = decodePacket(bytes);
    if (!decoded.ok) {
      this.invalid.push({ arrival, error: decoded.error, detail: decoded.detail });
      return;
    }
    const p = decoded.packet;
    const log = this.logs.get(p.source)!;
    const at = lowerBound(log, p.met);
    if (log[at]?.met === p.met && log[at]?.seq === p.seq) {
      this.duplicates++;
      return;
    }
    const entry: PacketEntry = { id: this.nextId++, source: p.source, seq: p.seq, met: p.met, arrival, flags: p.flags, bytes: bytes.slice() };
    log.splice(at, 0, entry);
    this.byId.set(entry.id, entry);
    if (log.length > this.logCapacity) this.byId.delete(log.shift()!.id);
    for (const s of p.samples) this.rings.get(s.channel)!.insert(p.met, s.value, s.quality, arrival, entry.id);
    this.alarmCache = null;
  }

  get now(): number {
    return this.latestArrival;
  }

  query(q: Query): QueryResult {
    const t = q.t;
    const window: [number, number] = [t - q.span * 0.75, t + q.span * 0.25];
    const values = q.channels.map((channel) => this.valueAt(channel, t));
    const views = q.channels.map((channel) => {
      const ring = this.rings.get(channel)!;
      const def = CHANNEL_BY_ID.get(channel)!;
      const v = downsample(ring, window[0], window[1], q.width, SOURCES[def.source].cadenceMs * 1.5, t);
      return { channel, points: v.points, min: v.min, max: v.max, count: v.count, gaps: v.gaps };
    });
    const rows = this.interval(q.source, window[0], window[1], t);
    return {
      t,
      window,
      source: q.source,
      width: q.width,
      values,
      views,
      alarms: this.alarmsAt(t),
      stats: this.statsAt(t),
      interval: nearest(rows, t),
      intervalTotal: rows.length,
      inspection: this.inspect(q.inspect ?? this.packetAt(q.source, t)?.id ?? null, t),
    };
  }

  valueAt(channel: number, t: number): ChannelValue {
    const ring = this.rings.get(channel)!;
    for (let i = ring.lowerBound(t + 0.5) - 1; i >= 0; i--) {
      const s = ring.slot(i);
      if (ring.arrival[s]! <= t) return { channel, value: ring.value[s]!, met: ring.met[s]!, quality: ring.quality[s]! };
    }
    return { channel, value: null, met: null, quality: null };
  }

  alarmsAt(t: number): (Alarm & { active: boolean })[] {
    this.alarmCache ??= ALARM_CHANNELS.flatMap((def) => limitAlarms(def, this.rings.get(def.id)!));
    const comms = this.rings.get(channelsOf(2)[0]!.id)!;
    return [...this.alarmCache, ...lossOfSignal(comms, t)]
      .filter((a) => a.raisedKnownAt <= t)
      .map((a) => {
        const cleared = a.clearedKnownAt !== null && a.clearedKnownAt <= t;
        return { ...a, clearedAt: cleared ? a.clearedAt : null, clearedKnownAt: cleared ? a.clearedKnownAt : null, active: !cleared };
      })
      .sort((a, b) => a.raisedAt - b.raisedAt);
  }

  statsAt(t: number): Stats {
    let packets = 0;
    let missing = 0;
    let retransmitted = 0;
    for (const [source, log] of this.logs) {
      const cadence = SOURCES[source].cadenceMs;
      let prev = NaN;
      for (const p of log) {
        if (p.arrival > t) continue;
        packets++;
        if (p.flags & 1) retransmitted++;
        if (!Number.isNaN(prev) && p.met - prev > cadence * 1.5) missing += Math.round((p.met - prev) / cadence) - 1;
        prev = p.met;
      }
    }
    const invalidByKind: Partial<Record<DecodeErrorKind, number>> = {};
    let invalid = 0;
    for (const i of this.invalid) {
      if (i.arrival > t) continue;
      invalid++;
      invalidByKind[i.error] = (invalidByKind[i.error] ?? 0) + 1;
    }
    let samples = 0;
    let capacity = 0;
    let bytes = 0;
    let dropped = 0;
    for (const ring of this.rings.values()) {
      samples += ring.length;
      capacity += ring.capacity;
      bytes += ring.bytes;
      dropped += ring.dropped;
    }
    return { packets, invalid, invalidByKind, missing, retransmitted, duplicates: this.duplicates, bufferSamples: samples, bufferCapacity: capacity, bufferBytes: bytes, dropped };
  }

  // Packets of one source inside the window that had arrived by t, with the holes between them.
  interval(source: Source, t0: number, t1: number, t: number): IntervalRow[] {
    const defs = channelsOf(source);
    const cadence = SOURCES[source].cadenceMs;
    const rows: IntervalRow[] = [];
    let prev = NaN;
    const log = this.logs.get(source)!;
    for (let i = Math.max(0, lowerBound(log, t0) - 1); i < log.length && log[i]!.met <= t1; i++) {
      const p = log[i]!;
      if (p.arrival > t) continue;
      if (!Number.isNaN(prev) && p.met - prev > cadence * 1.5 && p.met >= t0) {
        rows.push({ kind: 'gap', from: prev, to: p.met, missing: Math.round((p.met - prev) / cadence) - 1, open: false });
      }
      prev = p.met;
      if (p.met < t0) continue;
      const decoded = decodePacket(p.bytes);
      const samples = decoded.ok ? decoded.packet.samples : [];
      rows.push({
        kind: 'packet',
        id: p.id,
        met: p.met,
        seq: p.seq,
        arrival: p.arrival,
        flags: p.flags,
        values: defs.map((d) => samples.find((s) => s.channel === d.id)?.value ?? null),
        quality: defs.map((d) => samples.find((s) => s.channel === d.id)?.quality ?? 0),
      });
    }
    // Nothing since the last packet, up to the playhead: a gap that is still open.
    const until = Math.min(t, t1);
    if (!Number.isNaN(prev) && until - prev > cadence * 1.5) {
      rows.push({ kind: 'gap', from: prev, to: until, missing: Math.round((until - prev) / cadence) - 1, open: true });
    }
    return rows;
  }

  // The latest packet of a source at or before t that had arrived by t.
  packetAt(source: Source, t: number): PacketEntry | null {
    const log = this.logs.get(source)!;
    for (let i = lowerBound(log, t + 0.5) - 1; i >= 0; i--) if (log[i]!.arrival <= t) return log[i]!;
    return null;
  }

  inspect(id: number | null, t: number): Inspection | null {
    const p = id === null ? null : this.byId.get(id);
    if (!p || p.arrival > t) return null;
    const decoded = decodePacket(p.bytes);
    if (!decoded.ok) return null;
    const v = new DataView(p.bytes.buffer, p.bytes.byteOffset, p.bytes.byteLength);
    const n = decoded.packet.samples.length;
    return {
      id: p.id,
      source: p.source,
      sourceName: SOURCES[p.source].name,
      version: decoded.packet.version,
      flags: p.flags,
      seq: p.seq,
      met: p.met,
      arrival: p.arrival,
      length: p.bytes.length,
      samples: decoded.packet.samples.map((s) => {
        const def = CHANNEL_BY_ID.get(s.channel) as ChannelDef;
        return { channel: s.channel, key: def.key, name: def.name, value: s.value, unit: def.unit, decimals: def.decimals, quality: s.quality };
      }),
      bytes: [...p.bytes],
      fields: [
        { name: 'magic', offset: 0, size: 2, value: `0x${v.getUint16(0, true).toString(16)}` },
        { name: 'version', offset: 2, size: 1, value: String(v.getUint8(2)) },
        { name: 'flags', offset: 3, size: 1, value: p.flags & 1 ? '0x01 retransmitted' : '0x00' },
        { name: 'source', offset: 4, size: 2, value: `${p.source} ${SOURCES[p.source].name}` },
        { name: 'sequence', offset: 6, size: 2, value: String(p.seq) },
        { name: 'mission time', offset: 8, size: 4, value: `${p.met} ms` },
        { name: 'payload length', offset: 12, size: 2, value: `${n * SAMPLE_BYTES} bytes` },
        { name: 'samples', offset: 14, size: 1, value: String(n) },
        { name: 'payload', offset: HEADER_BYTES, size: n * SAMPLE_BYTES, value: `${n} × (channel u16, value f32, quality u8)` },
        { name: 'crc-16', offset: HEADER_BYTES + n * SAMPLE_BYTES, size: 2, value: `0x${v.getUint16(HEADER_BYTES + n * SAMPLE_BYTES, true).toString(16).padStart(4, '0')} ok` },
      ],
    };
  }
}

function nearest(rows: IntervalRow[], t: number): IntervalRow[] {
  if (rows.length <= MAX_ROWS) return rows;
  let at = 0;
  rows.forEach((r, i) => {
    if ((r.kind === 'packet' ? r.met : r.from) <= t) at = i;
  });
  const start = Math.max(0, Math.min(rows.length - MAX_ROWS, at - MAX_ROWS / 2));
  return rows.slice(start, start + MAX_ROWS);
}

function lowerBound(log: PacketEntry[], met: number): number {
  let lo = 0;
  let hi = log.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (log[mid]!.met < met) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
