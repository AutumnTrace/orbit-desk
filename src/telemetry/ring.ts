// One channel's samples, ordered by mission time, in a fixed-capacity ring.
//
// Columns live in typed arrays allocated once. Appending in time order (the normal case) is
// O(1); a delayed sample is inserted at its place by shifting the newer ones; when the ring is
// full the oldest sample is dropped. Recorded missions use a ring big enough to hold everything,
// live mode a ring sized to the history it keeps, so memory is fixed whatever arrives.

export const BYTES_PER_SAMPLE = 8 + 4 + 1 + 8 + 4; // met f64, value f32, quality u8, arrival f64, packet i32

export class SampleRing {
  readonly capacity: number;
  readonly met: Float64Array;
  readonly value: Float32Array;
  readonly quality: Uint8Array;
  readonly arrival: Float64Array;
  readonly packet: Int32Array;
  private head = 0;
  private count = 0;
  dropped = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.met = new Float64Array(capacity);
    this.value = new Float32Array(capacity);
    this.quality = new Uint8Array(capacity);
    this.arrival = new Float64Array(capacity);
    this.packet = new Int32Array(capacity);
  }

  get length(): number {
    return this.count;
  }

  get bytes(): number {
    return this.capacity * BYTES_PER_SAMPLE;
  }

  // Physical slot of the i-th sample in time order.
  slot(i: number): number {
    return (this.head + i) % this.capacity;
  }

  metAt(i: number): number {
    return this.met[this.slot(i)]!;
  }

  insert(met: number, value: number, quality: number, arrival: number, packet: number): void {
    if (this.count === this.capacity) {
      if (met < this.metAt(0)) {
        this.dropped++;
        return; // older than everything kept: it would be evicted at once
      }
      this.head = (this.head + 1) % this.capacity;
      this.count--;
      this.dropped++;
    }
    // Usually the new sample is the newest; otherwise find its place and shift the rest along.
    let at = this.count;
    if (at > 0 && met < this.metAt(at - 1)) {
      at = this.lowerBound(met);
      for (let i = this.count; i > at; i--) this.copy(this.slot(i - 1), this.slot(i));
    }
    const s = this.slot(at);
    this.met[s] = met;
    this.value[s] = value;
    this.quality[s] = quality;
    this.arrival[s] = arrival;
    this.packet[s] = packet;
    this.count++;
  }

  // First index whose met is >= the given time.
  lowerBound(met: number): number {
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.metAt(mid) < met) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private copy(from: number, to: number): void {
    this.met[to] = this.met[from]!;
    this.value[to] = this.value[from]!;
    this.quality[to] = this.quality[from]!;
    this.arrival[to] = this.arrival[from]!;
    this.packet[to] = this.packet[from]!;
  }
}
