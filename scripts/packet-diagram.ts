// Draws docs/packet.svg, the labelled byte layout of a version 1 packet, from the constants the
// decoder uses.  node scripts/packet-diagram.ts
import { writeFileSync } from 'node:fs';
import { CRC_BYTES, HEADER_BYTES, SAMPLE_BYTES } from '../src/telemetry/packet.ts';

const fields = [
  { name: 'magic', note: '0x4F44', size: 2 },
  { name: 'ver', note: '1', size: 1 },
  { name: 'flags', note: 'u8', size: 1 },
  { name: 'source', note: 'u16', size: 2 },
  { name: 'seq', note: 'u16', size: 2 },
  { name: 'mission time', note: 'u32, ms', size: 4 },
  { name: 'payload len', note: 'u16 = 7n', size: 2 },
  { name: 'n', note: 'u8', size: 1 },
  { name: 'rsv', note: '0', size: 1 },
];
const sample = [
  { name: 'channel', note: 'u16', size: 2 },
  { name: 'value', note: 'f32', size: 4 },
  { name: 'q', note: 'u8', size: 1 },
];

const unit = 64;
const left = 20;
let svg = '';
const box = (x: number, y: number, w: number, h: number, fill: string, name: string, note: string, offset: string) => {
  svg += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="${fill}" stroke="#30363d"/>`;
  svg += `<text x="${x + w / 2}" y="${y + 24}" class="name">${name}</text>`;
  svg += `<text x="${x + w / 2}" y="${y + 42}" class="note">${note}</text>`;
  svg += `<text x="${x + 3}" y="${y - 6}" class="off">${offset}</text>`;
};

let x = left;
let offset = 0;
svg += `<text x="${left}" y="22" class="title">orbit-desk packet, version 1 · little-endian · one source at one mission time</text>`;
for (const f of fields) {
  box(x, 52, f.size * unit, 56, '#16202b', f.name, f.note, String(offset));
  x += f.size * unit;
  offset += f.size;
}
svg += `<text x="${left}" y="128" class="sub">header: ${HEADER_BYTES} bytes · flags bit 0 = retransmitted · source 1 EPS, 2 COMMS, 3 ADCS · seq counts per source and wraps at 65536</text>`;

const y2 = 190;
x = left;
offset = HEADER_BYTES;
svg += `<text x="${left}" y="${y2 - 26}" class="sub">payload: n samples of ${SAMPLE_BYTES} bytes (q = quality: 0 good, 1 suspect, 2 bad), then the CRC</text>`;
for (let i = 0; i < 2; i++) {
  for (const f of sample) {
    box(x, y2, f.size * unit, 56, i === 0 ? '#1b2a1f' : '#182419', f.name, f.note, String(offset));
    x += f.size * unit;
    offset += f.size;
  }
}
svg += `<text x="${x + 18}" y="${y2 + 34}" class="name">…</text>`;
x += 40;
box(x, y2, CRC_BYTES * unit, 56, '#2b1d16', 'crc-16', 'CCITT-FALSE', `16+7n`);
svg += `<text x="${left}" y="${y2 + 92}" class="foot">CRC over bytes 0 … 16+7n−1. A recording stores each packet as: arrival u32 (ms) · length u16 · packet. A live WebSocket message is: arrival u32 · packet.</text>`;

const width = left + 16 * unit + 40;
writeFileSync('docs/packet.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="310" viewBox="0 0 ${width} 310" role="img" aria-label="Packet layout">
<style>
  text { font-family: ui-monospace, Consolas, monospace; fill: #d7dde4; text-anchor: middle; }
  .name { font-size: 13px; font-weight: 600; }
  .note { font-size: 11px; fill: #8b949e; }
  .off { font-size: 11px; fill: #5cc8ff; text-anchor: start; }
  .title { font-size: 14px; font-weight: 600; text-anchor: start; font-family: system-ui, sans-serif; }
  .sub, .foot { font-size: 12px; fill: #8b949e; text-anchor: start; font-family: system-ui, sans-serif; }
</style>
<rect width="100%" height="100%" fill="#0d1117"/>
${svg}
</svg>
`);
console.log('wrote docs/packet.svg');
