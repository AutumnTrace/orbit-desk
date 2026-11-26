import { CHANNEL_BY_KEY, type Source, SOURCES } from '../telemetry/channels.ts';
import { encodePacket, FLAG_RETRANSMITTED, type Quality } from '../telemetry/packet.ts';
import type { MissionMeta, RecordEntry } from '../telemetry/recording.ts';

// Three short missions of SIMSAT-1, a fictional spacecraft. Simulated, seeded, deterministic: the
// same mission id always produces the same bytes. Each one has the faults a real downlink has:
// packets that never arrive, packets that arrive late, and a few corrupted ones.

export type MissionId = 'normal-orbit' | 'battery-sag' | 'antenna-dropout';

export const MISSION_IDS: MissionId[] = ['normal-orbit', 'battery-sag', 'antenna-dropout'];

const DURATION = 9 * 60_000;
const ECLIPSE: [number, number] = [150_000, 390_000];

interface Plan {
  meta: MissionMeta;
  // Extra load on the bus, amps, as a function of mission time.
  load(met: number): number;
  // A one-sample transient on the battery voltage reading, if any.
  transient?: { met: number; value: number };
  // A loss of signal: COMMS is silent; EPS and ADCS are stored on board and sent afterwards.
  outage?: { from: number; to: number; replayFrom: number };
}

const plans: Record<MissionId, Plan> = {
  'normal-orbit': {
    meta: meta('normal-orbit', 'Normal orbit', 101,
      'A quiet pass: into eclipse at 02:30, out at 06:30. The battery takes the load in eclipse and recharges after.',
      [{ met: ECLIPSE[0], text: 'Eclipse entry' }, { met: ECLIPSE[1], text: 'Eclipse exit' }]),
    load: () => 0,
  },
  'battery-sag': {
    meta: meta('battery-sag', 'Battery sag', 202,
      'In eclipse a heater sticks on. At 04:18 a switching transient pulls the battery to 23.9 V for one sample, then the extra load sags it below its warning limit until fault protection sheds the heater at 04:26.',
      [{ met: 258_250, text: 'Battery transient, one sample' }, { met: 258_000, text: 'Heater stuck on' }, { met: 266_000, text: 'Heater shed' }]),
    load: (met) => (met >= 258_000 && met < 266_000 ? 5.0 : 0),
    transient: { met: 258_250, value: 23.9 },
  },
  'antenna-dropout': {
    meta: meta('antenna-dropout', 'Antenna dropout', 303,
      'At 05:10 the downlink fades and is lost for 40 s. COMMS has a real gap; EPS and ADCS packets from the outage were stored on board and arrive after the link comes back, marked retransmitted.',
      [{ met: 310_000, text: 'Loss of signal' }, { met: 350_000, text: 'Signal reacquired' }]),
    load: () => 0,
    outage: { from: 310_000, to: 350_000, replayFrom: 352_000 },
  },
};

function meta(id: MissionId, title: string, seed: number, description: string, notes: MissionMeta['notes']): MissionMeta {
  return { id, title, spacecraft: 'SIMSAT-1 (simulated)', description, durationMs: DURATION, seed, notes };
}

export function missionMeta(id: MissionId): MissionMeta {
  return plans[id].meta;
}

export function generateMission(id: MissionId): { meta: MissionMeta; records: RecordEntry[] } {
  const plan = plans[id];
  const random = mulberry32(plan.meta.seed);
  const noise = (scale: number) => (random() - 0.5) * 2 * scale;
  const records: RecordEntry[] = [];
  const seq: Record<Source, number> = { 1: 0, 2: 0, 3: 0 };
  let replayAt = plan.outage?.replayFrom ?? 0;

  let charge = 0.82; // battery state of charge
  let temperature = 18;

  for (let met = 0; met < DURATION; met += 250) {
    const inEclipse = met >= ECLIPSE[0] && met < ECLIPSE[1];
    const sun = 40 + 25 * Math.sin(met / 90_000) + noise(0.4);
    const solar = inEclipse ? 0 : Math.max(0, 6.4 * Math.cos((sun * Math.PI) / 180) + noise(0.05));
    const load = 4.6 + plan.load(met) + noise(0.08);
    const battery = solar - load;
    charge = Math.min(1, Math.max(0.05, charge + (battery * 0.25) / 3600 / 9));
    // Open-circuit voltage from charge, minus the drop across the internal resistance.
    let batteryV = 24.9 + 3.0 * charge + 0.25 * battery + noise(0.02);
    if (plan.transient && met === plan.transient.met) batteryV = plan.transient.value;
    temperature += (battery < -6 ? 0.012 : -0.002) + noise(0.002);
    temperature = Math.max(14, temperature);
    const busV = Math.min(28.6, batteryV + 0.35) + noise(0.01);

    const outage = plan.outage && met >= plan.outage.from && met < plan.outage.to;
    const fading = plan.outage && met >= plan.outage.from - 12_000 && met < plan.outage.from;

    // EPS, 4 Hz.
    emit(1, met, [
      ['bat_v', batteryV, 0],
      ['bat_i', battery, 0],
      ['sa_i', solar, 0],
      ['bus_v', busV, 0],
      ['bat_t', temperature, 0],
    ], outage);

    // COMMS, 2 Hz. Silent during the outage: those packets were never sent.
    if (met % 500 === 0 && !outage) {
      const fade = fading ? ((met - (plan.outage!.from - 12_000)) / 12_000) * 28 : 0;
      const rssi = -92 - fade + noise(0.8);
      const quality: Quality = fading && fade > 18 ? 1 : 0;
      emit(2, met, [
        ['rssi', rssi, quality],
        ['snr', 18 - fade * 0.8 + noise(0.4), quality],
        ['lock', 1, 0],
      ], false);
    }

    // ADCS, 1 Hz.
    if (met % 1000 === 0) {
      emit(3, met, [
        ['sun', sun, 0],
        ['rate', 0.02 + Math.abs(noise(0.004)), 0],
      ], outage);
    }
  }

  records.sort((a, b) => a.arrival - b.arrival);
  return { meta: plan.meta, records };

  function emit(source: Source, met: number, values: [string, number, Quality][], storedOnBoard: boolean | undefined) {
    const s = seq[source]++;
    const bytes = encodePacket({
      version: 1,
      flags: storedOnBoard ? FLAG_RETRANSMITTED : 0,
      source,
      seq: s,
      met,
      samples: values.map(([key, value, quality]) => ({ channel: CHANNEL_BY_KEY.get(key)!.id, value, quality })),
    });
    let arrival = met + 120 + Math.floor(random() * 40); // downlink latency
    if (storedOnBoard) {
      // Played back after reacquisition, faster than real time.
      arrival = replayAt;
      replayAt += SOURCES[source].cadenceMs / 8;
    } else {
      const roll = random();
      if (roll < 0.002) return; // lost for good
      if (roll < 0.006) arrival += 1000 + Math.floor(random() * 3000); // delayed
      if (roll > 0.9985) {
        records.push({ arrival, bytes: corrupt(bytes, random) }); // arrives damaged: lost
        return;
      }
    }
    records.push({ arrival, bytes });
  }
}

// Three ways a packet arrives broken: a flipped payload bit (CRC catches it), cut short, or
// garbage where the header should be.
function corrupt(bytes: Uint8Array, random: () => number): Uint8Array {
  const kind = Math.floor(random() * 3);
  if (kind === 0) {
    const copy = bytes.slice();
    copy[20] = copy[20]! ^ 0x10;
    return copy;
  }
  if (kind === 1) return bytes.slice(0, 11);
  const copy = bytes.slice();
  copy[0] = 0xff;
  copy[1] = 0xff;
  return copy;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
