// The channels of SIMSAT-1, a fictional spacecraft. All telemetry in this repository is simulated.

export type Source = 1 | 2 | 3;

export const SOURCES: Record<Source, { name: string; cadenceMs: number }> = {
  1: { name: 'EPS', cadenceMs: 250 }, // electrical power
  2: { name: 'COMMS', cadenceMs: 500 },
  3: { name: 'ADCS', cadenceMs: 1000 }, // attitude
};

export interface Limits {
  critLow?: number;
  warnLow?: number;
  warnHigh?: number;
  critHigh?: number;
  // How far back inside the limit a value must come before the alarm clears.
  hysteresis: number;
}

export interface ChannelDef {
  id: number;
  key: string;
  name: string;
  unit: string;
  source: Source;
  decimals: number;
  // Fixed plot range, so a lane does not rescale under you while you scrub.
  range: [number, number];
  limits?: Limits;
}

export const CHANNELS: ChannelDef[] = [
  { id: 101, key: 'bat_v', name: 'Battery voltage', unit: 'V', source: 1, decimals: 2, range: [22, 30],
    limits: { critLow: 24.5, warnLow: 25.5, warnHigh: 29.4, hysteresis: 0.15 } },
  { id: 102, key: 'bat_i', name: 'Battery current', unit: 'A', source: 1, decimals: 2, range: [-14, 6],
    limits: { critLow: -10, warnLow: -8, hysteresis: 0.3 } },
  { id: 103, key: 'sa_i', name: 'Solar array current', unit: 'A', source: 1, decimals: 2, range: [-0.5, 7.5] },
  { id: 104, key: 'bus_v', name: 'Main bus voltage', unit: 'V', source: 1, decimals: 2, range: [22, 30],
    limits: { critLow: 24.8, warnLow: 25.8, hysteresis: 0.15 } },
  { id: 105, key: 'bat_t', name: 'Battery temperature', unit: '°C', source: 1, decimals: 1, range: [0, 40],
    limits: { warnHigh: 30, critHigh: 35, hysteresis: 0.5 } },
  { id: 201, key: 'rssi', name: 'Downlink RSSI', unit: 'dBm', source: 2, decimals: 1, range: [-130, -70],
    limits: { warnLow: -115, hysteresis: 1 } },
  { id: 202, key: 'snr', name: 'Downlink SNR', unit: 'dB', source: 2, decimals: 1, range: [-5, 25] },
  { id: 203, key: 'lock', name: 'Receiver lock', unit: '', source: 2, decimals: 0, range: [-0.2, 1.2] },
  { id: 301, key: 'sun', name: 'Sun angle', unit: '°', source: 3, decimals: 1, range: [0, 180] },
  { id: 302, key: 'rate', name: 'Body rate', unit: '°/s', source: 3, decimals: 3, range: [0, 0.5] },
];

export const CHANNEL_BY_ID = new Map(CHANNELS.map((c) => [c.id, c]));
export const CHANNEL_BY_KEY = new Map(CHANNELS.map((c) => [c.key, c]));

export function channelsOf(source: Source): ChannelDef[] {
  return CHANNELS.filter((c) => c.source === source);
}
