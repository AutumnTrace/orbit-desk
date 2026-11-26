// Live mode: streams a simulated mission over WebSocket in mission time, one packet per message.
//
//   npm run sim                                  ws://localhost:8765
//   ws://localhost:8765/?mission=battery-sag&from=240&speed=1
//
// A message is exactly a recording record without its length: arrival MET u32 (little-endian),
// then the packet bytes. The browser decodes it with the same code it uses for recordings.
import { WebSocketServer } from 'ws';
import { generateMission, MISSION_IDS, type MissionId } from './missions.ts';

const port = Number(process.env.SIM_PORT ?? 8765);
const server = new WebSocketServer({ port });

server.on('connection', (socket, request) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const id = (url.searchParams.get('mission') ?? 'battery-sag') as MissionId;
  if (!MISSION_IDS.includes(id)) {
    socket.close(1008, `unknown mission ${id}`);
    return;
  }
  const speed = Math.max(0.1, Math.min(64, Number(url.searchParams.get('speed') ?? 1)));
  const from = Math.max(0, Number(url.searchParams.get('from') ?? 0) * 1000);
  const { records } = generateMission(id);
  const start = Date.now();
  let next = records.findIndex((r) => r.arrival >= from);
  if (next < 0) next = records.length;

  // Send everything due by now, every 20 ms: mission clock = from + elapsed × speed.
  const timer = setInterval(() => {
    const clock = from + (Date.now() - start) * speed;
    while (next < records.length && records[next]!.arrival <= clock) {
      const r = records[next++]!;
      const frame = new Uint8Array(4 + r.bytes.length);
      new DataView(frame.buffer).setUint32(0, r.arrival, true);
      frame.set(r.bytes, 4);
      socket.send(frame);
    }
    if (next >= records.length) {
      clearInterval(timer);
      socket.close(1000, 'end of mission');
    }
  }, 20);
  socket.on('close', () => clearInterval(timer));
  console.log(`client: ${id} from ${from / 1000}s at ${speed}x`);
});

console.log(`simulator on ws://localhost:${port} (missions: ${MISSION_IDS.join(', ')})`);
