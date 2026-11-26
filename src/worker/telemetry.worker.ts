/// <reference lib="webworker" />
// Decoding, buffering and every per-frame computation happen here, off the main thread. Results go
// back with their typed arrays transferred, not copied.
import { Engine } from '../telemetry/engine.ts';
import { readRecording } from '../telemetry/recording.ts';
import type { FromWorker, ToWorker } from './protocol.ts';

declare const self: DedicatedWorkerGlobalScope;

let engine: Engine | null = null;
let socket: WebSocket | null = null;
let liveTimer: ReturnType<typeof setInterval> | undefined;

const post = (message: FromWorker, transfer: Transferable[] = []) => self.postMessage(message, transfer);

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  try {
    switch (message.type) {
      case 'load': {
        stopLive();
        const response = await fetch(message.url);
        if (!response.ok) throw new Error(`${message.url}: HTTP ${response.status}`);
        const data = new Uint8Array(await response.arrayBuffer());
        const started = performance.now();
        engine = Engine.fromRecording(data);
        const decodeMs = performance.now() - started;
        post({ type: 'loaded', meta: engine.meta!, bytes: data.length, records: readRecording(data).records.length, decodeMs });
        break;
      }
      case 'connect': {
        stopLive();
        engine = new Engine(message.historyMs);
        const live = engine;
        post({ type: 'live', status: 'connecting', now: 0 });
        socket = new WebSocket(message.url);
        socket.binaryType = 'arraybuffer';
        socket.onopen = () => post({ type: 'live', status: 'open', now: live.now });
        socket.onmessage = (e: MessageEvent<ArrayBuffer>) => {
          // Same framing as a recording record: arrival MET u32, then the packet.
          const frame = new Uint8Array(e.data);
          if (frame.length < 4) return;
          live.receive(new DataView(e.data).getUint32(0, true), frame.subarray(4));
        };
        socket.onerror = () => post({ type: 'live', status: 'error', now: live.now, detail: `cannot reach ${message.url}` });
        socket.onclose = (e) => {
          post({ type: 'live', status: 'closed', now: live.now, detail: e.reason || undefined });
          clearInterval(liveTimer);
        };
        liveTimer = setInterval(() => post({ type: 'live', status: 'open', now: live.now }), 200);
        break;
      }
      case 'disconnect':
        stopLive();
        break;
      case 'query': {
        if (!engine) return;
        const started = performance.now();
        const result = engine.query(message.query);
        post({ type: 'result', id: message.id, result, computeMs: performance.now() - started },
          result.views.map((v) => v.points.buffer as ArrayBuffer));
        break;
      }
    }
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};

function stopLive() {
  clearInterval(liveTimer);
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
}
