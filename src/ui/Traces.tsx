import { useEffect, useRef } from 'react';
import { CHANNEL_BY_ID } from '../telemetry/channels.ts';
import type { QueryResult } from '../telemetry/engine.ts';
import { formatMet } from '../telemetry/met.ts';

const LANE = 104;
const PAD_LEFT = 8;
const PAD_RIGHT = 8;
const AXIS = 22;
const COLORS = ['#5cc8ff', '#ffb454', '#7ee787', '#d2a8ff', '#ff7b72', '#f2cc60', '#56d4bc', '#ff9bce'];

export function colorOf(index: number): string {
  return COLORS[index % COLORS.length]!;
}

interface Props {
  result: QueryResult;
  onSeek(t: number): void;
  onZoom(direction: 1 | -1): void;
  onDrawn?(ms: number): void;
}

// Synchronized traces: one lane per channel on a shared time axis. Drawn on one canvas from the
// already-reduced points the worker sends, so the cost per frame is about four points per pixel
// column per lane, whatever the zoom.
export function Traces({ result, onSeek, onZoom, onDrawn }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // Redraw when the data changes, not when the parent re-renders with a new callback.
  const drawn = useRef(onDrawn);
  drawn.current = onDrawn;

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const started = performance.now();
    const dpr = window.devicePixelRatio || 1;
    const width = el.clientWidth;
    const height = result.views.length * LANE + AXIS;
    el.width = Math.round(width * dpr);
    el.height = Math.round(height * dpr);
    el.style.height = `${height}px`;
    const ctx = el.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const [w0, w1] = result.window;
    const plotW = width - PAD_LEFT - PAD_RIGHT;
    const x = (met: number) => PAD_LEFT + ((met - w0) / (w1 - w0)) * plotW;
    const playX = x(result.t);

    result.views.forEach((view, lane) => {
      const def = CHANNEL_BY_ID.get(view.channel)!;
      const top = lane * LANE;
      const [lo, hi] = def.range;
      const y = (v: number) => top + 8 + (1 - (v - lo) / (hi - lo)) * (LANE - 16);

      ctx.fillStyle = lane % 2 ? '#11161c' : '#131920';
      ctx.fillRect(0, top, width, LANE);

      // Gaps: missing data is shaded and labelled, never drawn as a value.
      ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
      for (const [from, to] of view.gaps) {
        const gx = Math.max(PAD_LEFT, x(from));
        const gw = Math.min(width - PAD_RIGHT, x(to)) - gx;
        if (gw <= 0) continue;
        ctx.fillRect(gx, top + 1, gw, LANE - 2);
        if (gw > 60) {
          ctx.fillStyle = '#7d8590';
          ctx.font = '11px system-ui, sans-serif';
          ctx.fillText(`no data ${((to - from) / 1000).toFixed(1)} s`, gx + 6, top + LANE - 10);
          ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
        }
      }

      // Limits.
      const limits = def.limits;
      if (limits) {
        ctx.setLineDash([4, 4]);
        for (const [value, color] of [
          [limits.warnLow, '#d29922'], [limits.warnHigh, '#d29922'], [limits.critLow, '#f85149'], [limits.critHigh, '#f85149'],
        ] as [number | undefined, string][]) {
          if (value === undefined || value < lo || value > hi) continue;
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.55;
          ctx.beginPath();
          ctx.moveTo(PAD_LEFT, y(value));
          ctx.lineTo(width - PAD_RIGHT, y(value));
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }

      // The trace. A NaN pair lifts the pen.
      ctx.save();
      ctx.beginPath();
      ctx.rect(PAD_LEFT, top, plotW, LANE);
      ctx.clip();
      ctx.strokeStyle = colorOf(lane);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      let pen = false;
      const p = view.points;
      for (let i = 0; i < p.length; i += 2) {
        if (Number.isNaN(p[i]!)) {
          pen = false;
          continue;
        }
        const px = x(p[i]!);
        const py = y(p[i + 1]!);
        if (pen) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
        pen = true;
      }
      ctx.stroke();
      ctx.restore();

      ctx.strokeStyle = '#2a313a';
      ctx.beginPath();
      ctx.moveTo(0, top + LANE - 0.5);
      ctx.lineTo(width, top + LANE - 0.5);
      ctx.stroke();
    });

    // Not yet received: everything right of the playhead.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fillRect(playX, 0, width - playX, height - AXIS);

    // Time axis.
    const axisTop = height - AXIS;
    ctx.fillStyle = '#8b949e';
    ctx.font = '11px ui-monospace, Consolas, monospace';
    const step = niceStep((w1 - w0) / 6);
    for (let t = Math.ceil(w0 / step) * step; t <= w1; t += step) {
      const tx = x(t);
      ctx.fillRect(tx, axisTop, 1, 4);
      ctx.fillText(formatMet(t, step < 1000), tx - 18, axisTop + 16);
    }

    ctx.strokeStyle = '#f0f6fc';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(playX + 0.5, 0);
    ctx.lineTo(playX + 0.5, axisTop);
    ctx.stroke();

    drawn.current?.(performance.now() - started);
  }, [result]);

  const seekAt = (clientX: number) => {
    const el = canvas.current!;
    const rect = el.getBoundingClientRect();
    const [w0, w1] = result.window;
    const fraction = (clientX - rect.left - PAD_LEFT) / (rect.width - PAD_LEFT - PAD_RIGHT);
    onSeek(Math.round(w0 + fraction * (w1 - w0)));
  };

  return (
    <canvas
      ref={canvas}
      className="traces"
      data-testid="traces"
      data-t={result.t}
      data-width={result.width}
      aria-label="Traces of the selected channels. The table below lists the same samples."
      role="img"
      onClick={(e) => seekAt(e.clientX)}
      onWheel={(e) => onZoom(e.deltaY > 0 ? 1 : -1)}
    />
  );
}

function niceStep(raw: number): number {
  const steps = [250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000];
  return steps.find((s) => s >= raw) ?? 600_000;
}

export const LANE_HEIGHT = LANE;
