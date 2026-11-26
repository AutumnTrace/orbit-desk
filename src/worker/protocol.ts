import type { Query, QueryResult } from '../telemetry/engine.ts';
import type { MissionMeta } from '../telemetry/recording.ts';

export type ToWorker =
  | { type: 'load'; url: string }
  | { type: 'connect'; url: string; historyMs: number }
  | { type: 'disconnect' }
  | { type: 'query'; id: number; query: Query };

export type FromWorker =
  | { type: 'loaded'; meta: MissionMeta; bytes: number; records: number; decodeMs: number }
  | { type: 'live'; status: 'connecting' | 'open' | 'closed' | 'error'; now: number; detail?: string }
  | { type: 'result'; id: number; result: QueryResult; computeMs: number }
  | { type: 'error'; message: string };
