import { CHANNELS, type ChannelDef } from './channels.ts';
import type { SampleRing } from './ring.ts';

export type Severity = 'warning' | 'critical';

export interface Alarm {
  id: string;
  channel: string; // channel key, or "comms" for loss of signal
  severity: Severity;
  text: string;
  raisedAt: number; // mission time of the sample that crossed the limit
  clearedAt: number | null;
  // When each transition became known: the arrival of the samples it depends on.
  raisedKnownAt: number;
  clearedKnownAt: number | null;
}

export const LOS_AFTER_MS = 3000;

// Limit alarms with hysteresis, evaluated in mission-time order. A transition becomes known once
// every sample up to it in mission time has arrived, so the alarms shown at a playhead depend only
// on what had arrived by then, whether the playhead got there by playing or by seeking.
export function limitAlarms(def: ChannelDef, ring: SampleRing): Alarm[] {
  const limits = def.limits;
  if (!limits) return [];
  const alarms: Alarm[] = [];
  let open: Alarm | null = null;
  let level: Severity | null = null;
  let known = 0;

  const severityOf = (v: number, current: Severity | null): Severity | null => {
    // Inside the hysteresis band an active alarm stays at its level.
    const h = current ? limits.hysteresis : 0;
    if ((limits.critLow !== undefined && v < limits.critLow + (current === 'critical' ? h : 0))
      || (limits.critHigh !== undefined && v > limits.critHigh - (current === 'critical' ? h : 0))) return 'critical';
    if ((limits.warnLow !== undefined && v < limits.warnLow + h)
      || (limits.warnHigh !== undefined && v > limits.warnHigh - h)) return 'warning';
    return null;
  };

  for (let i = 0; i < ring.length; i++) {
    const s = ring.slot(i);
    const met = ring.met[s]!;
    const value = ring.value[s]!;
    known = Math.max(known, ring.arrival[s]!);
    const next = severityOf(value, level);
    if (next !== level) {
      if (open) {
        open.clearedAt = met;
        open.clearedKnownAt = known;
        alarms.push(open);
        open = null;
      }
      if (next) {
        open = {
          id: `${def.key}@${met}`,
          channel: def.key,
          severity: next,
          text: `${def.name} ${describe(def, value)}`,
          raisedAt: met,
          clearedAt: null,
          raisedKnownAt: known,
          clearedKnownAt: null,
        };
      }
      level = next;
    }
  }
  if (open) alarms.push(open);
  return alarms;
}

// No COMMS packet for LOS_AFTER_MS: loss of signal. Known as soon as the time has passed.
export function lossOfSignal(comms: SampleRing, now: number): Alarm[] {
  const alarms: Alarm[] = [];
  let prev = NaN;
  let known = 0;
  for (let i = 0; i < comms.length; i++) {
    const s = comms.slot(i);
    if (comms.arrival[s]! > now) continue;
    const met = comms.met[s]!;
    known = Math.max(known, comms.arrival[s]!);
    if (!Number.isNaN(prev) && met - prev > LOS_AFTER_MS) alarms.push(los(prev, met, known));
    prev = met;
  }
  if (!Number.isNaN(prev) && now - prev >= LOS_AFTER_MS) alarms.push(los(prev, null, null));
  return alarms;
}

function los(lastMet: number, resumedMet: number | null, resumedKnownAt: number | null): Alarm {
  return {
    id: `los@${lastMet + LOS_AFTER_MS}`,
    channel: 'comms',
    severity: 'critical',
    text: 'Loss of signal: no COMMS packets',
    raisedAt: lastMet + LOS_AFTER_MS,
    clearedAt: resumedMet,
    raisedKnownAt: lastMet + LOS_AFTER_MS,
    clearedKnownAt: resumedKnownAt,
  };
}

function describe(def: ChannelDef, value: number): string {
  const l = def.limits!;
  const low = (l.warnLow !== undefined && value < l.warnLow) || (l.critLow !== undefined && value < l.critLow);
  return `${low ? 'below' : 'above'} limit (${value.toFixed(def.decimals)} ${def.unit})`.trim();
}

export const ALARM_CHANNELS = CHANNELS.filter((c) => c.limits);
