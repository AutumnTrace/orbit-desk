// Chart latency in a real browser: plays the battery-sag recording at 16× for each window size and
// records, per frame, the worker's compute time, the round trip to the worker, and the canvas draw.
//   npm run build && npm run bench:chart        (starts its own preview server on :4174)
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const port = 4174;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort'], { stdio: 'ignore' });
const url = `http://localhost:${port}`;
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(url)).ok) break;
  } catch {
    await new Promise((r) => setTimeout(r, 250));
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;
console.log(`Chromium ${browser.version()} headless, 1600×1000 at DPR 1; battery-sag, 4 lanes (bat_v, bat_i, sa_i, bus_v), 16× playback for 4 s each`);
console.log('');
console.log('| window | frames | points drawn p50 | worker compute p50 / p95 | round trip p50 / p95 | draw p50 / p95 |');
console.log('| ---: | ---: | ---: | ---: | ---: | ---: |');
try {
  for (const span of [15, 60, 180, 600]) {
    await page.goto(`${url}/?mission=battery-sag&t=07:00.000&span=${span}&ch=bat_v,bat_i,sa_i,bus_v&bench`);
    await page.getByTestId('traces').waitFor();
    await page.waitForTimeout(500);
    await page.getByRole('combobox', { name: 'Speed' }).selectOption('16');
    await page.evaluate(() => (window.__orbitFrames!.length = 0));
    await page.getByTestId('play').click();
    await page.waitForTimeout(4000);
    await page.getByTestId('play').click();
    const frames = await page.evaluate(() => window.__orbitFrames!);
    const f = (key: 'computeMs' | 'roundTripMs' | 'drawMs') => frames.map((x) => x[key]);
    const ms = (xs: number[]) => `${pct(xs, 50).toFixed(2)} / ${pct(xs, 95).toFixed(2)} ms`;
    console.log(`| ${span} s | ${frames.length} | ${pct(frames.map((x) => x.points), 50)} | ${ms(f('computeMs'))} | ${ms(f('roundTripMs'))} | ${ms(f('drawMs'))} |`);
  }
} finally {
  await browser.close();
  server.kill();
}
