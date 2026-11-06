import type { FanoutClock } from "@/lib/close-api/token-quote-fanout";

interface Timer {
  at: number;
  seq: number;
  fire: () => void;
}

/** Lets every pending promise callback run, without touching a timer. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Virtual time for the quote fan-out. Nothing waits: `run` lets the work settle as far as it can,
 * then jumps the clock straight to the next timer, until the work is done.
 */
export class FakeClock implements FanoutClock {
  private t = 0;
  private seq = 0;
  private timers: Timer[] = [];
  /** What `random()` returns. */
  rand = 0.5;

  now(): number {
    return this.t;
  }

  random(): number {
    return this.rand;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.schedule(ms, resolve));
  }

  timeout<T>(work: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let done = false;
      this.schedule(ms, () => {
        if (done) return;
        done = true;
        reject(new Error(`fake timeout after ${ms} ms`));
      });
      work.then(
        (value) => {
          if (done) return;
          done = true;
          resolve(value);
        },
        (error: unknown) => {
          if (done) return;
          done = true;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      );
    });
  }

  /** A promise that resolves with `value` once `ms` of virtual time have passed. */
  after<T>(ms: number, value: T): Promise<T> {
    return this.sleep(ms).then(() => value);
  }

  async run<T>(work: Promise<T>): Promise<T> {
    let settled = false;
    work.then(
      () => (settled = true),
      () => (settled = true)
    );
    for (;;) {
      await flush();
      if (settled) return work;
      if (this.timers.length === 0) throw new Error("fake clock: work is stuck with no timer");
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers.shift()!;
      this.t = Math.max(this.t, next.at);
      next.fire();
    }
  }

  private schedule(ms: number, fire: () => void): void {
    this.timers.push({ at: this.t + Math.max(0, ms), seq: this.seq++, fire });
  }
}
