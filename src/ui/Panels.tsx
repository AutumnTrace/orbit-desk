import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { CHANNEL_BY_ID, CHANNELS, channelsOf, type Source, SOURCES } from '../telemetry/channels.ts';
import type { IntervalRow, QueryResult } from '../telemetry/engine.ts';
import { formatMet } from '../telemetry/met.ts';
import { QUALITY_NAMES } from '../telemetry/packet.ts';
import { colorOf, LANE_HEIGHT } from './Traces.tsx';

type Alarm = QueryResult['alarms'][number];

export function AlarmPanel({ alarms, onSelect }: { alarms: Alarm[]; onSelect(alarm: Alarm): void }) {
  return (
    <section className="panel alarms" aria-labelledby="alarms-title">
      <h2 id="alarms-title">
        Alarms <span className="count">{alarms.filter((a) => a.active).length} active</span>
      </h2>
      {alarms.length === 0 ? (
        <p className="muted">None so far.</p>
      ) : (
        <ol>
          {alarms.map((a) => (
            <li key={a.id}>
              <button type="button" className={`alarm ${a.severity} ${a.active ? 'active' : 'cleared'}`} onClick={() => onSelect(a)} data-testid="alarm">
                <span className="when">{formatMet(a.raisedAt)}</span>
                <span className="what">{a.text}</span>
                <span className="state">{a.active ? 'active' : `cleared ${formatMet(a.clearedAt!)}`}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const PRESETS: { name: string; keys: string[] }[] = [
  { name: 'Power', keys: ['bat_v', 'bat_i', 'sa_i', 'bus_v'] },
  { name: 'Comms', keys: ['rssi', 'snr', 'lock'] },
  { name: 'Attitude', keys: ['sun', 'rate'] },
];

export function ChannelPicker({ selected, onChange }: { selected: string[]; onChange(keys: string[]): void }) {
  const toggle = (key: string) =>
    onChange(selected.includes(key) ? selected.filter((k) => k !== key) : CHANNELS.map((c) => c.key).filter((k) => k === key || selected.includes(k)));
  return (
    <section className="panel channels" aria-labelledby="channels-title">
      <h2 id="channels-title">Channels</h2>
      <div className="presets" role="group" aria-label="Channel presets">
        {PRESETS.map((p) => (
          <button key={p.name} type="button" onClick={() => onChange(p.keys)} aria-pressed={p.keys.join() === selected.join()}>
            {p.name}
          </button>
        ))}
      </div>
      {([1, 2, 3] as Source[]).map((source) => (
        <fieldset key={source}>
          <legend>{SOURCES[source].name}</legend>
          {channelsOf(source).map((c) => (
            <label key={c.key}>
              <input type="checkbox" checked={selected.includes(c.key)} onChange={() => toggle(c.key)} />
              {c.name}
            </label>
          ))}
        </fieldset>
      ))}
    </section>
  );
}

export function LaneLabels({ result }: { result: QueryResult }) {
  return (
    <div className="lane-labels">
      {result.views.map((view, i) => {
        const def = CHANNEL_BY_ID.get(view.channel)!;
        const now = result.values[i]!;
        const fmt = (v: number) => `${v.toFixed(def.decimals)}${def.unit ? ` ${def.unit}` : ''}`;
        return (
          <div className="lane-label" key={view.channel} style={{ height: LANE_HEIGHT }} data-testid={`lane-${def.key}`}>
            <span className="swatch" style={{ background: colorOf(i) }} />
            <strong>{def.name}</strong>
            <span className="value" data-testid={`value-${def.key}`}>
              {now.value === null ? '—' : fmt(now.value)}
              {now.met !== null && result.t - now.met > SOURCES[def.source].cadenceMs * 2 ? (
                <span className="stale"> no data for {((result.t - now.met) / 1000).toFixed(1)} s</span>
              ) : null}
            </span>
            <span className="range" data-testid={`range-${def.key}`}>
              {view.count === 0 ? 'no data in window' : `window min ${fmt(view.min)} · max ${fmt(view.max)}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function Inspector({ result }: { result: QueryResult }) {
  const p = result.inspection;
  const [hover, setHover] = useState<number | null>(null);
  if (!p) {
    return (
      <section className="panel inspector" aria-labelledby="inspector-title">
        <h2 id="inspector-title">Packet</h2>
        <p className="muted">No packet of this source has arrived by {formatMet(result.t)}.</p>
      </section>
    );
  }
  const field = hover === null ? null : p.fields.find((f) => hover >= f.offset && hover < f.offset + f.size);
  return (
    <section className="panel inspector" aria-labelledby="inspector-title" data-testid="inspector">
      <h2 id="inspector-title">
        Packet {p.sourceName} #{p.seq}
      </h2>
      <dl className="header-fields">
        <dt>Mission time</dt>
        <dd data-testid="inspector-met">{formatMet(p.met)}</dd>
        <dt>Arrived</dt>
        <dd>
          {formatMet(p.arrival)} {p.arrival - p.met > 1000 ? <span className="late">({((p.arrival - p.met) / 1000).toFixed(1)} s late)</span> : null}
        </dd>
        <dt>Flags</dt>
        <dd>{p.flags & 1 ? 'retransmitted' : 'none'}</dd>
        <dt>Length</dt>
        <dd>{p.length} bytes, CRC ok</dd>
      </dl>
      <table className="samples">
        <thead>
          <tr>
            <th>Channel</th>
            <th>Value</th>
            <th>Quality</th>
          </tr>
        </thead>
        <tbody>
          {p.samples.map((s) => (
            <tr key={s.channel} className={s.quality ? 'q-off' : ''}>
              <td>
                {s.name} <span className="muted">{s.channel}</span>
              </td>
              <td className="num" data-testid={`inspect-${s.key}`}>
                {s.value.toFixed(s.decimals)} {s.unit}
              </td>
              <td>{QUALITY_NAMES[s.quality as 0 | 1 | 2]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="hex" aria-label="Packet bytes" onMouseLeave={() => setHover(null)}>
        {p.bytes.map((b, i) => (
          <span
            key={i}
            className={field && i >= field.offset && i < field.offset + field.size ? 'hit' : ''}
            onMouseEnter={() => setHover(i)}
          >
            {b.toString(16).padStart(2, '0')}
          </span>
        ))}
      </div>
      <p className="field-note">{field ? `${field.name} · bytes ${field.offset}–${field.offset + field.size - 1} · ${field.value}` : 'Hover a byte to see its field.'}</p>
    </section>
  );
}

interface TableProps {
  result: QueryResult;
  source: Source;
  onSource(source: Source): void;
  onInspect(id: number, arrival: number): void;
}

// The samples behind the traces, for the visible window, as a table you can walk with the keyboard.
export function IntervalTable({ result, source, onSource, onInspect }: TableProps) {
  // Columns follow the rows on screen, which may still be the previous source for a frame.
  const defs = channelsOf(result.source);
  const rows = result.interval;
  const [focus, setFocus] = useState(0);
  const body = useRef<HTMLTableSectionElement>(null);
  const selected = result.inspection?.id;

  useEffect(() => {
    if (focus >= rows.length) setFocus(Math.max(0, rows.length - 1));
  }, [rows.length, focus]);

  // Keep the row at the playhead in view while it moves, unless the keyboard is in the table.
  useEffect(() => {
    const el = body.current;
    if (!el || el.contains(document.activeElement)) return;
    let at = -1;
    rows.forEach((r, i) => {
      if ((r.kind === 'packet' ? r.met : r.from) <= result.t) at = i;
    });
    const row = el.querySelectorAll<HTMLTableRowElement>('tr')[at];
    const scroller = el.closest('.table-scroll') as HTMLElement | null;
    if (row && scroller) scroller.scrollTop = row.offsetTop - scroller.clientHeight / 2;
  }, [rows, result.t]);

  const move = (to: number) => {
    const next = Math.max(0, Math.min(rows.length - 1, to));
    setFocus(next);
    body.current?.querySelectorAll<HTMLTableRowElement>('tr')[next]?.focus();
  };
  const onKey = (e: KeyboardEvent, row: IntervalRow, index: number) => {
    const keys: Record<string, number> = { ArrowDown: index + 1, ArrowUp: index - 1, PageDown: index + 10, PageUp: index - 10, Home: 0, End: rows.length - 1 };
    if (e.key in keys) {
      e.preventDefault();
      e.stopPropagation();
      move(keys[e.key]!);
    } else if (e.key === 'Enter' && row.kind === 'packet') {
      e.stopPropagation();
      onInspect(row.id, row.arrival);
    }
  };

  return (
    <section className="panel interval" aria-labelledby="interval-title">
      <div className="interval-head">
        <h2 id="interval-title">
          Samples {formatMet(Math.max(0, result.window[0]), false)}–{formatMet(result.window[1], false)}
        </h2>
        <div role="group" aria-label="Source">
          {([1, 2, 3] as Source[]).map((s) => (
            <button key={s} type="button" aria-pressed={s === source} onClick={() => onSource(s)}>
              {SOURCES[s].name}
            </button>
          ))}
        </div>
        <span className="muted">
          {result.intervalTotal > rows.length ? `${rows.length} of ${result.intervalTotal} rows, nearest the playhead · ` : ''}↑ ↓ to move, Enter to inspect
        </span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Mission time</th>
              <th>Seq</th>
              {defs.map((d) => (
                <th key={d.key}>
                  {d.name} {d.unit && <span className="muted">{d.unit}</span>}
                </th>
              ))}
              <th>Arrived</th>
            </tr>
          </thead>
          <tbody ref={body}>
            {rows.map((row, i) =>
              row.kind === 'gap' ? (
                <tr key={`gap-${row.from}`} className="gap" tabIndex={i === focus ? 0 : -1} onKeyDown={(e) => onKey(e, row, i)} onFocus={() => setFocus(i)}>
                  <td colSpan={defs.length + 3}>
                    {row.open
                      ? `No data since ${formatMet(row.from)}: ${row.missing} packet${row.missing === 1 ? '' : 's'} not received so far`
                      : `No data ${formatMet(row.from)}–${formatMet(row.to)}: ${row.missing} packet${row.missing === 1 ? '' : 's'} missing`}
                  </td>
                </tr>
              ) : (
                <tr
                  key={row.id}
                  tabIndex={i === focus ? 0 : -1}
                  aria-selected={row.id === selected}
                  className={row.id === selected ? 'selected' : ''}
                  onKeyDown={(e) => onKey(e, row, i)}
                  onFocus={() => setFocus(i)}
                  onClick={() => onInspect(row.id, row.arrival)}
                >
                  <td className="num">{formatMet(row.met)}</td>
                  <td className="num">{row.seq}</td>
                  {row.values.map((v, k) => (
                    <td key={k} className={`num ${row.quality[k] ? 'q-off' : ''}`}>
                      {v === null ? '—' : v.toFixed(defs[k]!.decimals)}
                    </td>
                  ))}
                  <td className="num">
                    {formatMet(row.arrival)}
                    {row.flags & 1 ? ' ↻' : ''}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
