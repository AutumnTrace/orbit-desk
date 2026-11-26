import { CHANNEL_BY_KEY, type Source } from '../telemetry/channels.ts';
import { formatMet, parseMet } from '../telemetry/met.ts';

// Everything needed to reopen an incident: mission, playhead, window, channels, source and the
// packet in the inspector. ?mission=battery-sag&t=04:18.250&span=60&ch=bat_v,bat_i&src=1&pkt=…

export interface ViewState {
  mission: string;
  t: number;
  span: number;
  channels: string[];
  source: Source;
  packet: number | null;
}

export const DEFAULT_STATE: ViewState = {
  mission: 'battery-sag',
  t: 240_000,
  span: 60_000,
  channels: ['bat_v', 'bat_i', 'sa_i', 'bus_v'],
  source: 1,
  packet: null,
};

export const SPANS = [15_000, 60_000, 180_000, 600_000];

export function toSearch(state: ViewState): string {
  const params = new URLSearchParams();
  params.set('mission', state.mission);
  params.set('t', formatMet(state.t));
  params.set('span', String(state.span / 1000));
  params.set('ch', state.channels.join(','));
  params.set('src', String(state.source));
  if (state.packet !== null) params.set('pkt', String(state.packet));
  return `?${params.toString().replace(/%3A/g, ':').replace(/%2C/g, ',')}`;
}

export function fromSearch(search: string): ViewState {
  const params = new URLSearchParams(search);
  const t = parseMet(params.get('t') ?? '');
  const span = Number(params.get('span'));
  const channels = (params.get('ch') ?? '').split(',').filter((k) => CHANNEL_BY_KEY.has(k));
  const source = Number(params.get('src'));
  const packet = Number(params.get('pkt'));
  return {
    mission: params.get('mission') ?? DEFAULT_STATE.mission,
    t: t ?? DEFAULT_STATE.t,
    span: Number.isFinite(span) && span >= 5 && span <= 3600 ? span * 1000 : DEFAULT_STATE.span,
    channels: channels.length > 0 ? channels : DEFAULT_STATE.channels,
    source: source === 1 || source === 2 || source === 3 ? source : DEFAULT_STATE.source,
    packet: Number.isInteger(packet) && packet > 0 ? packet : null,
  };
}
