import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CHANNEL_BY_KEY, CHANNELS, type Source } from '../telemetry/channels.ts';
import type { QueryResult } from '../telemetry/engine.ts';
import { formatMet } from '../telemetry/met.ts';
import type { MissionMeta } from '../telemetry/recording.ts';
import { TelemetryClient } from '../worker/client.ts';
import { AlarmPanel, ChannelPicker, Inspector, IntervalTable, LaneLabels } from './Panels.tsx';
import { Traces } from './Traces.tsx';
import { fromSearch, SPANS, toSearch, type ViewState } from './url.ts';

const MISSIONS = [
  { id: 'normal-orbit', title: 'Normal orbit' },
  { id: 'battery-sag', title: 'Battery sag' },
  { id: 'antenna-dropout', title: 'Antenna dropout' },
];
const SPEEDS = [1, 4, 16];
const LIVE_HISTORY_MS = 5 * 60_000;

// ?bench records per-frame timings in window.__orbitFrames for bench/chart.ts.
const BENCH = new URLSearchParams(window.location.search).has('bench');
declare global {
  interface Window {
    __orbitFrames?: { computeMs: number; roundTripMs: number; drawMs: number; points: number }[];
  }
}
if (BENCH) window.__orbitFrames = [];

type Mode = { kind: 'recorded' } | { kind: 'live'; url: string; status: string; following: boolean };

export function App() {
  const initial = useMemo(() => fromSearch(window.location.search), []);
  const [state, setState] = useState<ViewState>(initial);
  const [mode, setMode] = useState<Mode>(() => {
    const live = new URLSearchParams(window.location.search).get('live');
    return live ? { kind: 'live', url: live, status: 'connecting', following: true } : { kind: 'recorded' };
  });
  const [meta, setMeta] = useState<MissionMeta | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [loadInfo, setLoadInfo] = useState('');
  const [liveNow, setLiveNow] = useState(0);
  const [copied, setCopied] = useState(false);
  const [timing, setTiming] = useState({ compute: 0, draw: 0 });
  const lastFrame = useRef({ computeMs: 0, roundTripMs: 0, points: 0 });
  const client = useRef<TelemetryClient | null>(null);
  const width = useRef(900);
  const stateRef = useRef(state);
  stateRef.current = state;

  const duration = mode.kind === 'live' ? liveNow : (meta?.durationMs ?? 0);

  // One worker for the page.
  useEffect(() => {
    const c = new TelemetryClient();
    client.current = c;
    c.onResult = (r, computeMs, roundTripMs) => {
      lastFrame.current = { computeMs, roundTripMs, points: r.views.reduce((n, v) => n + v.points.length / 2, 0) };
      setResult(r);
      setTiming((t) => ({ ...t, compute: computeMs }));
    };
    c.onMessage = (m) => {
      if (m.type === 'loaded') {
        setMeta(m.meta);
        setLoadInfo(`${(m.bytes / 1024).toFixed(0)} KiB, ${m.records.toLocaleString('en')} records decoded in ${m.decodeMs.toFixed(0)} ms`);
      } else if (m.type === 'live') {
        setLiveNow(m.now);
        setMode((mode) => (mode.kind === 'live' ? { ...mode, status: m.detail ? `${m.status}: ${m.detail}` : m.status } : mode));
      } else if (m.type === 'error') {
        setLoadInfo(`error: ${m.message}`);
      }
    };
    return () => c.terminate();
  }, []);

  // Data source: a recording, or the simulator.
  useEffect(() => {
    setResult(null);
    if (mode.kind === 'live') {
      client.current?.send({ type: 'connect', url: mode.url, historyMs: LIVE_HISTORY_MS });
    } else {
      setMeta(null);
      client.current?.send({ type: 'load', url: `${import.meta.env.BASE_URL}missions/${state.mission}.odr` });
    }
  }, [state.mission, mode.kind, mode.kind === 'live' ? mode.url : '']);

  // Live: the playhead follows the newest arrival unless you have paused to look back.
  useEffect(() => {
    if (mode.kind === 'live' && mode.following) setState((s) => ({ ...s, t: liveNow }));
  }, [liveNow, mode]);

  // Ask the worker for the frame at the current state.
  const ready = mode.kind === 'live' || meta !== null;
  useEffect(() => {
    if (!ready) return;
    client.current?.query({
      t: state.t,
      span: state.span,
      width: width.current,
      channels: state.channels.map((k) => CHANNEL_BY_KEY.get(k)!.id),
      source: state.source,
      inspect: state.packet,
    });
  }, [state, ready, liveNow]);

  // Keep the address bar shareable (recorded missions only: live data is not reproducible).
  useEffect(() => {
    if (mode.kind !== 'recorded') return;
    const timer = setTimeout(() => window.history.replaceState(null, '', toSearch(state)), 150);
    return () => clearTimeout(timer);
  }, [state, mode.kind]);

  // Playback: advance mission time with the wall clock.
  useEffect(() => {
    if (!playing || mode.kind === 'live') return;
    let last = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const dt = (now - last) * speed;
      last = now;
      setState((s) => {
        const t = Math.min(duration, s.t + dt);
        if (t >= duration) setPlaying(false);
        return { ...s, t: Math.round(t), packet: null };
      });
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, duration, mode.kind]);

  const seek = useCallback(
    (t: number) => {
      setState((s) => ({ ...s, t: Math.max(0, Math.min(duration, Math.round(t))), packet: null }));
      if (mode.kind === 'live') setMode((m) => (m.kind === 'live' ? { ...m, following: false } : m));
    },
    [duration, mode.kind],
  );

  const zoom = useCallback((direction: 1 | -1) => {
    setState((s) => {
      const i = SPANS.indexOf(s.span);
      const next = SPANS[Math.max(0, Math.min(SPANS.length - 1, (i < 0 ? 1 : i) + direction))]!;
      return { ...s, span: next };
    });
  }, []);

  const goToAlarm = useCallback(
    (alarm: QueryResult['alarms'][number]) => {
      setPlaying(false);
      // Land where the alarm became known, so the sample that raised it is on screen, and show
      // its channel if it is not shown already.
      setState((s) => ({
        ...s,
        t: Math.max(alarm.raisedKnownAt, alarm.raisedAt),
        packet: null,
        channels: alarm.channel === 'comms' || s.channels.includes(alarm.channel) ? s.channels : [...s.channels, alarm.channel],
        source: alarm.channel === 'comms' ? 2 : (CHANNEL_BY_KEY.get(alarm.channel)?.source ?? s.source),
      }));
      if (mode.kind === 'live') setMode((m) => (m.kind === 'live' ? { ...m, following: false } : m));
    },
    [mode.kind],
  );

  // Keyboard: Space play/pause, arrows step, [ ] zoom, a / A next and previous alarm.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, select, textarea, .table-scroll')) return;
      const s = stateRef.current;
      if (e.key === ' ' && target.tagName !== 'BUTTON') {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        seek(s.t + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10_000 : 1000));
      } else if (e.key === '[' || e.key === ']') {
        zoom(e.key === '[' ? 1 : -1);
      } else if ((e.key === 'a' || e.key === 'A') && result) {
        const list = e.key === 'a' ? result.alarms.filter((a) => a.raisedAt > s.t + 1) : result.alarms.filter((a) => a.raisedKnownAt < s.t - 1).reverse();
        if (list[0]) goToAlarm(list[0]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [seek, zoom, goToAlarm, result]);

  const traceBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = traceBox.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      width.current = Math.max(200, el.clientWidth - 220);
      setState((s) => ({ ...s }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const copyLink = async () => {
    await navigator.clipboard.writeText(window.location.origin + window.location.pathname + toSearch(state)).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <strong>orbit-desk</strong>
          <span>SIMSAT-1 · simulated telemetry</span>
        </div>
        <label className="mission">
          <span className="sr-only">Mission</span>
          <select
            value={mode.kind === 'live' ? 'live' : state.mission}
            onChange={(e) => {
              if (e.target.value === 'live') {
                setMode({ kind: 'live', url: `ws://localhost:8765/?mission=${state.mission}&from=240`, status: 'connecting', following: true });
              } else {
                setMode({ kind: 'recorded' });
                setPlaying(false);
                setState((s) => ({ ...s, mission: e.target.value, t: 0, packet: null }));
              }
            }}
            data-testid="mission"
          >
            {MISSIONS.map((m) => (
              <option key={m.id} value={m.id}>
                Recorded: {m.title}
              </option>
            ))}
            <option value="live">Live: simulator on ws://localhost:8765</option>
          </select>
        </label>
        <div className="transport" role="group" aria-label="Playback">
          <button type="button" onClick={() => seek(state.t - 30_000)} title="Back 30 s" data-testid="back-30">
            −30 s
          </button>
          {mode.kind === 'live' && !mode.following ? (
            <button type="button" onClick={() => setMode({ ...mode, following: true })} className="primary">
              Back to live
            </button>
          ) : (
            <button type="button" onClick={() => setPlaying((p) => !p)} className="primary" data-testid="play" disabled={mode.kind === 'live'}>
              {playing ? 'Pause' : 'Play'}
            </button>
          )}
          <button type="button" onClick={() => seek(state.t + 1000)} title="Forward 1 s">
            +1 s
          </button>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Speed">
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </div>
        <div className="met" aria-live="off">
          <span className="label">Mission time</span>
          <span className="clock" data-testid="met">
            {formatMet(state.t)}
          </span>
        </div>
        <label className="span">
          Window
          <select value={state.span} onChange={(e) => setState((s) => ({ ...s, span: Number(e.target.value) }))} data-testid="span">
            {SPANS.map((s) => (
              <option key={s} value={s}>
                {s / 1000} s
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={copyLink} disabled={mode.kind === 'live'} data-testid="copy-link">
          {copied ? 'Link copied' : 'Copy link'}
        </button>
      </header>

      <aside className="left">
        <AlarmPanel alarms={result?.alarms ?? []} onSelect={goToAlarm} />
        <ChannelPicker selected={state.channels} onChange={(channels) => setState((s) => ({ ...s, channels }))} />
      </aside>

      <main className="center">
        <Overview duration={duration} t={state.t} alarms={result?.alarms ?? []} notes={meta?.notes ?? []} onSeek={seek} />
        <div className="trace-grid" ref={traceBox}>
          {result && <LaneLabels result={result} />}
          {result && (
            <Traces
              result={result}
              onSeek={seek}
              onZoom={zoom}
              onDrawn={(draw) => {
                if (BENCH) window.__orbitFrames!.push({ ...lastFrame.current, drawMs: draw });
                setTiming((t) => (Math.abs(t.draw - draw) > 0.2 ? { ...t, draw } : t));
              }}
            />
          )}
          {!result && <p className="loading">{mode.kind === 'live' ? `Live: ${mode.status}` : 'Loading the recording…'}</p>}
        </div>
        {result && (
          <footer className="stats" data-testid="stats">
            <span>{result.stats.packets.toLocaleString('en')} packets</span>
            <span data-testid="missing">{result.stats.missing} missing</span>
            <span>{result.stats.retransmitted} retransmitted</span>
            <span data-testid="invalid" title={Object.entries(result.stats.invalidByKind).map(([k, n]) => `${k}: ${n}`).join(', ')}>
              {result.stats.invalid} invalid skipped
              {result.stats.invalid > 0 ? ` (${Object.entries(result.stats.invalidByKind).map(([k, n]) => `${n} ${k}`).join(', ')})` : ''}
            </span>
            {mode.kind === 'live' ? (
              <span data-testid="buffer">
                buffer {result.stats.bufferSamples.toLocaleString('en')}/{result.stats.bufferCapacity.toLocaleString('en')} samples, {(result.stats.bufferBytes / 1024).toFixed(0)} KiB fixed, {result.stats.dropped} evicted · {mode.status}
              </span>
            ) : (
              <span>{loadInfo}</span>
            )}
            <span className="timing">
              worker {timing.compute.toFixed(1)} ms · draw {timing.draw.toFixed(1)} ms
            </span>
          </footer>
        )}
        {result && (
          <IntervalTable
            result={result}
            source={state.source}
            onSource={(source: Source) => setState((s) => ({ ...s, source, packet: null }))}
            onInspect={(id, arrival) => setState((s) => ({ ...s, packet: id, t: Math.max(s.t, arrival) }))}
          />
        )}
      </main>

      <aside className="right">{result && <Inspector result={result} />}</aside>
    </div>
  );
}

function Overview({
  duration,
  t,
  alarms,
  notes,
  onSeek,
}: {
  duration: number;
  t: number;
  alarms: QueryResult['alarms'];
  notes: MissionMeta['notes'];
  onSeek(t: number): void;
}) {
  const at = (met: number) => `${(Math.min(Math.max(met, 0), duration) / Math.max(1, duration)) * 100}%`;
  return (
    <div
      className="overview"
      role="slider"
      aria-label="Mission timeline"
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-valuenow={t}
      aria-valuetext={formatMet(t)}
      tabIndex={0}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onSeek(((e.clientX - r.left) / r.width) * duration);
      }}
    >
      {notes.map((n) => (
        <span key={n.text} className="note" style={{ left: at(n.met) }} title={`${formatMet(n.met)} ${n.text}`} />
      ))}
      {alarms.map((a) => (
        <span key={a.id} className={`tick ${a.severity}`} style={{ left: at(a.raisedAt) }} />
      ))}
      <span className="head" style={{ left: at(t) }} />
      <span className="start">{formatMet(0, false)}</span>
      <span className="end">{formatMet(duration, false)}</span>
    </div>
  );
}

export const ALL_CHANNEL_KEYS = CHANNELS.map((c) => c.key);
