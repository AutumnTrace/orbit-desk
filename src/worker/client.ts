import type { Query, QueryResult } from '../telemetry/engine.ts';
import type { FromWorker, ToWorker } from './protocol.ts';

// The main thread's handle on the worker. Queries are coalesced: while one is being computed,
// newer ones replace each other, and only the latest is sent next. A slow frame is skipped, never
// queued behind.
export class TelemetryClient {
  private readonly worker = new Worker(new URL('./telemetry.worker.ts', import.meta.url), { type: 'module' });
  private nextId = 1;
  private firstValidId = 1;
  private inFlight = false;
  private pending: Query | null = null;
  private sentAt = 0;
  // computeMs: inside the worker; roundTripMs: from posting the query to receiving the answer.
  onResult: (result: QueryResult, computeMs: number, roundTripMs: number) => void = () => {};
  onMessage: (message: FromWorker) => void = () => {};

  constructor() {
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const message = e.data;
      if (message.type === 'result') {
        this.inFlight = false;
        // Ignore answers about data that has since been replaced (another mission, live again).
        if (message.id >= this.firstValidId) this.onResult(message.result, message.computeMs, performance.now() - this.sentAt);
        if (this.pending) {
          const next = this.pending;
          this.pending = null;
          this.query(next);
        }
      } else {
        this.onMessage(message);
      }
    };
  }

  send(message: ToWorker): void {
    if (message.type !== 'query') {
      this.firstValidId = this.nextId;
      this.pending = null;
    }
    this.worker.postMessage(message);
  }

  query(query: Query): void {
    if (this.inFlight) {
      this.pending = query;
      return;
    }
    this.inFlight = true;
    this.sentAt = performance.now();
    this.send({ type: 'query', id: this.nextId++, query });
  }

  terminate(): void {
    this.worker.terminate();
  }
}
