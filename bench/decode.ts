// Decode throughput and memory, in Node, with the decoder and engine the browser uses.
//   npm run bench:decode
import { cpus } from 'node:os';
import { generateMission, MISSION_IDS } from '../src/sim/missions.ts';
import { Engine } from '../src/telemetry/engine.ts';
import { decodePacket } from '../src/telemetry/packet.ts';

const REPEAT = 40;
const records = MISSION_IDS.flatMap((id) => generateMission(id).records);
const bytes = records.reduce((n, r) => n + r.bytes.length, 0);

function time(label: string, run: () => void, rounds = 5): number {
  run(); // warm-up
  const times: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const started = performance.now();
    run();
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!;
}

// 1. decodePacket alone over every record of the three missions, REPEAT times.
let ok = 0;
const decodeMs = time('decode', () => {
  ok = 0;
  for (let k = 0; k < REPEAT; k++) for (const r of records) if (decodePacket(r.bytes).ok) ok++;
});
const decoded = records.length * REPEAT;

// 2. The live path: decode, file into the per-channel rings, keep the packet log.
//    A five-minute ring sees ~1.5 h of mission time stream through it.
const live = new Engine(5 * 60_000);
const heapBefore = process.memoryUsage().heapUsed;
const engineMs = time('engine', () => {
  for (let k = 0; k < 10; k++) for (const r of records) live.receive(r.arrival + k * 600_000, r.bytes);
}, 1);
const stats = live.statsAt(Infinity);
const heapAfter = process.memoryUsage().heapUsed;

const mb = (n: number) => (n / 1e6).toFixed(1);
console.log(`Node ${process.version}, ${cpus()[0]?.model.trim()}, ${records.length} records (${mb(bytes)} MB) from ${MISSION_IDS.join(', ')}`);
console.log('');
console.log('| measure | result |');
console.log('| --- | ---: |');
console.log(`| decodePacket, ${decoded.toLocaleString('en')} packets (median of 5) | ${Math.round(decoded / (decodeMs / 1000)).toLocaleString('en')} packets/s, ${mb((bytes * REPEAT) / (decodeMs / 1000))} MB/s |`);
console.log(`| decode + ring insert + packet log, ${(records.length * 10).toLocaleString('en')} packets | ${Math.round((records.length * 10) / (engineMs / 1000)).toLocaleString('en')} packets/s |`);
console.log(`| live ring capacity (5 min history, all 10 channels) | ${stats.bufferCapacity.toLocaleString('en')} samples, ${(stats.bufferBytes / 1024).toFixed(0)} KiB, fixed |`);
console.log(`| samples evicted from the rings while streaming | ${stats.dropped.toLocaleString('en')} |`);
console.log(`| JS heap growth over that stream (approximate) | ${mb(heapAfter - heapBefore)} MB |`);
if (ok !== decoded - (decoded - ok)) throw new Error('unreachable');
