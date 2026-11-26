import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateMission, MISSION_IDS } from '../src/sim/missions.ts';
import { CHANNEL_BY_KEY } from '../src/telemetry/channels.ts';
import { Engine, type Query } from '../src/telemetry/engine.ts';
import { writeRecording } from '../src/telemetry/recording.ts';
import { DEFAULT_STATE, fromSearch, toSearch } from '../src/ui/url.ts';

const load = (id: string) => Engine.fromRecording(new Uint8Array(readFileSync(`public/missions/${id}.odr`)));
const id = (key: string) => CHANNEL_BY_KEY.get(key)!.id;
const query = (t: number, extra: Partial<Query> = {}): Query => ({
  t,
  span: 60_000,
  width: 900,
  channels: ['bat_v', 'bat_i', 'sa_i', 'bus_v', 'rssi'].map(id),
  source: 1,
  inspect: null,
  ...extra,
});

describe('the recorded missions', () => {
  it('are the seeded ones: regenerating gives the committed bytes', () => {
    for (const mission of MISSION_IDS) {
      const { meta, records } = generateMission(mission);
      const fresh = createHash('sha256').update(writeRecording(meta, records)).digest('hex');
      const committed = createHash('sha256').update(readFileSync(`public/missions/${mission}.odr`)).digest('hex');
      expect(fresh, mission).toBe(committed);
    }
  });

  it('battery-sag: the 04:18 dip is one sample, below the critical limit, and the battery recovers', () => {
    const e = load('battery-sag');
    const alarms = e.alarmsAt(300_000);
    const critical = alarms.find((a) => a.channel === 'bat_v' && a.severity === 'critical')!;
    expect(critical.raisedAt).toBe(258_250);
    expect(critical.clearedAt).toBe(258_500);
    expect(alarms.filter((a) => a.channel === 'bat_v').every((a) => !a.active)).toBe(true);
    expect(e.valueAt(id('bat_v'), 300_000).value!).toBeGreaterThan(25.8);
  });

  it('antenna-dropout: COMMS has a real gap; EPS fills in once the stored packets arrive', () => {
    const e = load('antenna-dropout');
    const during = e.query(query(351_000, { channels: [id('rssi'), id('bat_v')] }));
    expect(during.views[0]!.gaps.some(([a, b]) => a < 310_000 && b >= 350_000)).toBe(true);
    expect(during.views[1]!.gaps.some(([a, b]) => a < 310_000 && b > 349_000)).toBe(true);
    expect(during.alarms.some((a) => a.text.startsWith('Loss of signal') && a.clearedAt === 350_000)).toBe(true);

    // The stored packets are played back over about 10 s after reacquisition.
    const later = e.query(query(370_000, { channels: [id('rssi'), id('bat_v')] }));
    expect(later.views[0]!.gaps.some(([a, b]) => a < 310_000 && b >= 350_000)).toBe(true); // COMMS: still a gap
    expect(later.views[1]!.gaps.filter(([a, b]) => a < 350_000 && b > 310_000)).toEqual([]); // EPS: filled in
    expect(later.stats.retransmitted).toBeGreaterThan(150);
  });

  it('never reports a missing sample as zero', () => {
    const e = load('antenna-dropout');
    const r = e.query(query(330_000, { channels: [id('rssi')], span: 180_000 }));
    const values = [...r.views[0]!.points].filter((v, i) => i % 2 === 1 && !Number.isNaN(v));
    expect(Math.max(...values)).toBeLessThan(-80);
    expect(values).not.toContain(0);
    expect(e.valueAt(id('rssi'), 330_000).met!).toBeLessThan(310_000);
  });
});

// The release check: the state shown at a mission time does not depend on how the playhead got
// there. Linear playback in quarter-second steps, a direct seek, and a seek past then back.
describe('seeking and replaying', () => {
  for (const mission of MISSION_IDS) {
    it(`${mission}: seek back and replay matches a linear run`, () => {
      const e = load(mission);
      const targets = [258_300, 320_000, 352_500, 400_000];
      const linear = new Map<number, string>();
      for (let t = 0; t <= 400_000; t += 250) {
        if (targets.includes(t) || targets.some((x) => x > t - 250 && x < t)) {
          for (const x of targets.filter((x) => x > t - 250 && x <= t)) linear.set(x, fingerprint(e.query(query(x))));
        }
      }
      for (const t of targets) {
        e.query(query(t + 30_000));
        const back = fingerprint(e.query(query(t)));
        const direct = fingerprint(load(mission).query(query(t)));
        expect(back).toBe(linear.get(t));
        expect(direct).toBe(linear.get(t));
      }
    });
  }
});

describe('shareable URLs', () => {
  it('carry the whole view and read back the same', () => {
    const state = { mission: 'battery-sag', t: 258_250, span: 60_000, channels: ['bat_v', 'bus_v'], source: 2 as const, packet: 1039 };
    const search = toSearch(state);
    expect(search).toBe('?mission=battery-sag&t=04:18.250&span=60&ch=bat_v,bus_v&src=2&pkt=1039');
    expect(fromSearch(search)).toEqual(state);
  });

  it('fall back to defaults for anything unreadable', () => {
    expect(fromSearch('?t=later&span=0&ch=nope&src=7&pkt=-1')).toEqual({ ...DEFAULT_STATE, mission: 'battery-sag' });
  });
});

function fingerprint(r: ReturnType<Engine['query']>): string {
  return JSON.stringify({
    values: r.values,
    views: r.views.map((v) => ({ ...v, points: [...v.points] })),
    alarms: r.alarms,
    stats: r.stats,
    interval: r.interval,
    inspection: r.inspection,
  });
}
