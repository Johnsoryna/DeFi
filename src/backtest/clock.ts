/**
 * Clock abstraction for backtesting.
 * Modules use getClock().now() instead of Date.now() so time can be controlled
 * in backtesting mode (VirtualClock) while remaining transparent in production (RealClock).
 */

// ─── Clock Interface ─────────────────────────────────────────────────

export interface Clock {
  /** Returns the current time in Unix milliseconds. */
  now(): number
}

// ─── Real Clock (production) ─────────────────────────────────────────

export class RealClock implements Clock {
  now(): number {
    return Date.now()
  }
}

// ─── Virtual Clock (backtesting) ─────────────────────────────────────

export class VirtualClock implements Clock {
  private _now: number

  constructor(startTime: number) {
    this._now = startTime
  }

  now(): number {
    return this._now
  }

  /** Advance the clock to the given Unix-ms timestamp. */
  advanceTo(ts: number): void {
    if (ts < this._now) {
      throw new Error(`Cannot move clock backwards: ${ts} < ${this._now}`)
    }
    this._now = ts
  }
}

// ─── Global Clock Singleton ──────────────────────────────────────────

let activeClock: Clock = new RealClock()

/**
 * Get the currently active clock.
 * In production this returns RealClock (Date.now).
 * In backtest mode this returns VirtualClock.
 */
export function getClock(): Clock {
  return activeClock
}

/**
 * Replace the active clock. Used by the backtest harness to inject VirtualClock.
 * Returns the previous clock so callers can restore it.
 */
export function setClock(clock: Clock): Clock {
  const prev = activeClock
  activeClock = clock
  return prev
}
