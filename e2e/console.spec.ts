import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { decodePacket } from '../src/telemetry/packet.ts';
import { readRecording } from '../src/telemetry/recording.ts';

const INCIDENT = '/?mission=battery-sag&t=04:18.500&span=60&ch=bat_v,bat_i,sa_i,bus_v&src=1';

// Wait until the frame on screen is the one for the mission time in the clock.
async function settled(page: Page) {
  await expect(page.getByTestId('traces')).toBeVisible();
  const met = (await page.getByTestId('met').textContent())!;
  const [m, s] = met.split(':');
  const t = Math.round(Number(m) * 60_000 + Number(s) * 1000);
  await expect(page.getByTestId('traces')).toHaveAttribute('data-t', String(t));
  // ...and reduced for the width the canvas has now, not the default before layout.
  const width = await page.locator('.trace-grid').evaluate((el) => Math.max(200, el.clientWidth - 220));
  await expect(page.getByTestId('traces')).toHaveAttribute('data-width', String(width));
  await page.waitForTimeout(150);
}

// Everything a person reads off the screen, plus the pixels of the traces.
async function state(page: Page) {
  await settled(page);
  return {
    met: await page.getByTestId('met').textContent(),
    url: new URL(page.url()).search,
    lanes: await page.locator('.lane-label').allTextContents(),
    alarms: await page.getByTestId('alarm').allTextContents(),
    inspector: await page.getByTestId('inspector').textContent(),
    // Without the timings, which are wall-clock measurements rather than state.
    stats: (await page.getByTestId('stats').textContent())!.replace(/worker .*$/, '').replace(/decoded in \d+ ms/, ''),
    // The canvas's own pixels: exactly what was drawn, independent of where the page put it.
    traces: await page.getByTestId('traces').evaluate((c) => (c as HTMLCanvasElement).toDataURL()),
  };
}

test('the incident link opens on the dip, its alarm and its packet', async ({ page }) => {
  await page.goto(INCIDENT);
  await settled(page);
  await expect(page.getByTestId('met')).toHaveText('04:18.500');
  await expect(page.getByTestId('value-bat_v')).toHaveText('23.90 V');
  await expect(page.getByTestId('range-bat_v')).toContainText('window min 23.90 V');
  await expect(page.getByTestId('alarm').filter({ hasText: 'Battery voltage below limit (23.90 V)' })).toBeVisible();
  await expect(page.getByTestId('inspector-met')).toHaveText('04:18.250');
  await expect(page.getByTestId('inspect-bat_v')).toHaveText('23.90 V');
});

test('a copied link opens the same incident in a fresh tab', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  await page.goto('/?mission=antenna-dropout&t=06:00.000');
  await settled(page);
  // Arrange a view by hand: comms channels, the loss-of-signal alarm, a wider window, a packet.
  await page.getByRole('button', { name: 'Comms', exact: true }).click();
  await page.getByTestId('alarm').filter({ hasText: 'Loss of signal' }).click();
  await page.getByTestId('span').selectOption('180000');
  await page.getByRole('button', { name: 'COMMS', exact: true }).click();
  await page.locator('.interval tbody tr:not(.gap)').nth(3).click();
  await page.getByTestId('copy-link').click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  const before = await state(page);

  const fresh = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const tab = await fresh.newPage();
  await tab.goto(link);
  const after = await state(tab);
  expect(after).toEqual(before);
  await context.close();
  await fresh.close();
});

test('clicking an alarm seeks to the moment it became known', async ({ page }) => {
  await page.goto('/?mission=battery-sag&t=05:30.000&ch=sa_i');
  await settled(page);
  await page.getByTestId('alarm').filter({ hasText: '23.90 V' }).click();
  // The dip is at 04:18.250 and arrived 135 ms later.
  await expect(page.getByTestId('met')).toHaveText('04:18.385');
  await expect(page.getByTestId('value-bat_v')).toHaveText('23.90 V');
});

test('rewinding thirty seconds and replaying to the same time shows the same thing', async ({ page }) => {
  await page.goto('/?mission=battery-sag&t=04:30.000&span=60&ch=bat_v,bat_i,sa_i,bus_v&src=1');
  const linear = await state(page);
  await page.getByTestId('back-30').click();
  await expect(page.getByTestId('met')).toHaveText('04:00.000');
  await page.locator('body').click({ position: { x: 5, y: 995 } });
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('met')).toHaveText('04:30.000');
  expect(await state(page)).toEqual(linear);
});

test('an invalid packet is counted and skipped while playback carries on', async ({ page }) => {
  // Find the first damaged record of the normal-orbit recording.
  const { records } = readRecording(new Uint8Array(readFileSync('public/missions/normal-orbit.odr')));
  const bad = records.find((r) => !decodePacket(r.bytes).ok)!;
  const start = bad.arrival - 3000;
  await page.goto(`/?mission=normal-orbit&t=${(start / 1000).toFixed(3)}&ch=bat_v`);
  await settled(page);
  const invalidBefore = Number((await page.getByTestId('invalid').textContent())!.split(' ')[0]);
  await page.getByRole('combobox', { name: 'Speed' }).selectOption('4');
  await page.getByTestId('play').click();
  await page.waitForTimeout(2500);
  await page.getByTestId('play').click();
  const met = await page.getByTestId('met').textContent();
  const [m, s] = met!.split(':');
  expect(Number(m) * 60_000 + Number(s) * 1000).toBeGreaterThan(bad.arrival + 2000);
  const invalidAfter = Number((await page.getByTestId('invalid').textContent())!.split(' ')[0]);
  expect(invalidAfter).toBeGreaterThan(invalidBefore);
  await expect(page.getByTestId('value-bat_v')).toHaveText(/^\d+\.\d\d V$/);
});

test('during a loss of signal the comms lanes say how old their last value is', async ({ page }) => {
  await page.goto('/?mission=antenna-dropout&t=05:40.000&ch=rssi,bat_v');
  await settled(page);
  await expect(page.getByTestId('value-rssi')).toContainText('no data for 30.');
  await expect(page.locator('.interval tr.gap').last()).toContainText('No data since 05:09');
});

test('the sample table works from the keyboard', async ({ page }) => {
  await page.goto(INCIDENT);
  await settled(page);
  const first = page.locator('.interval tbody tr[tabindex="0"]');
  await first.focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.interval tbody tr').nth(2)).toBeFocused();
  const seq = await page.locator('.interval tbody tr').nth(2).locator('td').nth(1).textContent();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('inspector')).toContainText(`#${seq}`);
});

test('live mode streams from the simulator into a fixed-size buffer', async ({ page }) => {
  await page.goto('/?live=' + encodeURIComponent('ws://localhost:8765/?mission=battery-sag&from=250&speed=4'));
  await expect(page.getByTestId('buffer')).toContainText('open', { timeout: 15_000 });
  await expect(page.getByTestId('buffer')).toContainText('KiB fixed');
  const first = await page.getByTestId('met').textContent();
  await page.waitForTimeout(1500);
  expect(await page.getByTestId('met').textContent()).not.toBe(first);
  await expect(page.getByTestId('alarm').first()).toBeVisible({ timeout: 15_000 });
});

test('no serious accessibility violations', async ({ page }) => {
  await page.goto(INCIDENT);
  await settled(page);
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
});
