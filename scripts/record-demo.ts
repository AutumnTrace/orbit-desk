// Records docs/media/incident.gif from the built app: the battery-sag incident, played, clicked,
// rewound and followed. Every frame is a screenshot of the running page; only the caption bar on
// top is added.  npm run build && npm run record
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium, type Page } from '@playwright/test';
import sharp from 'sharp';

const port = 4175;
const url = `http://localhost:${port}`;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort'], { stdio: 'ignore' });
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(url)).ok) break;
  } catch {
    await new Promise((r) => setTimeout(r, 250));
  }
}

const W = 1600;
const H = 940;
const CAPTION = 54;
const OUT_WIDTH = 1280;
const frames: { png: Buffer; delay: number }[] = [];
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

async function frame(page: Page, caption: string, delay: number) {
  const shot = await page.screenshot();
  const bar = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${CAPTION}">
    <rect width="${W}" height="${CAPTION}" fill="#1f6feb"/>
    <text x="18" y="35" font-family="Segoe UI, system-ui, sans-serif" font-size="23" font-weight="600" fill="#ffffff">${esc(caption)}</text></svg>`);
  const png = await sharp({ create: { width: W, height: H + CAPTION, channels: 3, background: '#0d1117' } })
    .composite([{ input: bar, top: 0, left: 0 }, { input: shot, top: CAPTION, left: 0 }])
    .png()
    .toBuffer();
  frames.push({ png, delay });
}

async function settle(page: Page) {
  await page.waitForTimeout(250);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.goto(`${url}/?mission=battery-sag&t=04:08.000&span=60&ch=bat_v,bat_i,sa_i,bus_v&src=1`);
  await page.getByTestId('traces').waitFor();
  await settle(page);
  await frame(page, 'SIMSAT-1, battery-sag recording (simulated). 04:08 in eclipse; the battery carries the load.', 2600);

  await page.getByRole('combobox', { name: 'Speed' }).selectOption('4');
  await page.getByTestId('play').click();
  for (let i = 0; i < 9; i++) {
    await page.waitForTimeout(330);
    await frame(page, 'Playing at 4×. At 04:18 the battery voltage dips and the alarms fire.', 330);
  }
  await page.getByTestId('play').click();
  await settle(page);
  await frame(page, 'Playing at 4×. At 04:18 the battery voltage dips and the alarms fire.', 1600);

  await page.getByTestId('alarm').filter({ hasText: '23.90 V' }).click();
  await settle(page);
  await frame(page, 'Click the critical alarm: the playhead lands where it became known, 04:18.385.', 3600);

  await page.getByTestId('back-30').click();
  await settle(page);
  await frame(page, 'Rewind thirty seconds.', 1800);

  await page.getByTestId('span').selectOption('180000');
  await page.getByRole('combobox', { name: 'Speed' }).selectOption('16');
  await page.getByTestId('play').click();
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(330);
    await frame(page, 'Follow the power channels at 16×: the heater is shed at 04:26 and the battery recovers.', 330);
  }
  await page.getByTestId('play').click();
  await settle(page);
  await frame(page, 'Follow the power channels at 16×: the heater is shed at 04:26 and the battery recovers.', 3800);

  mkdirSync('docs/media', { recursive: true });
  const scaled = await Promise.all(frames.map((f) => sharp(f.png).resize({ width: OUT_WIDTH }).png().toBuffer()));
  const gif = await sharp(scaled, { join: { animated: true } })
    .gif({ delay: frames.map((f) => f.delay), loop: 0, effort: 8, colours: 96, dither: 0 })
    .toBuffer();
  writeFileSync('docs/media/incident.gif', gif);
  writeFileSync('docs/media/incident.png', await sharp(scaled[frames.findIndex((f) => f.delay === 3600)]!).png().toBuffer());
  console.log(`incident.gif: ${frames.length} frames, ${(gif.length / 1024).toFixed(0)} KiB`);
} finally {
  await browser.close();
  server.kill();
}
