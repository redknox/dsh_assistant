export interface Clock {
  now(): number
}

export class FakeClock implements Clock {
  constructor(private current: number) {}

  now(): number {
    return this.current
  }

  advance(ms: number): void {
    if (ms < 0) throw new Error('cannot rewind the fake clock')
    this.current += ms
  }
}

export interface EverySchedule {
  readonly kind: 'every'
  readonly everyMs: number
  nextRunAt: number
}

/** Process-local interval scheduler. Not an Agent Loop, and not durable across restarts. */
export class IntervalScheduler {
  private readonly schedules = new Map<string, EverySchedule>()

  constructor(
    private readonly clock: Clock,
    private readonly onDue: (name: string) => void,
  ) {}

  scheduleEvery(name: string, everyMs: number): EverySchedule {
    if (!Number.isInteger(everyMs) || everyMs < 1) {
      throw new Error('everyMs must be a positive integer')
    }
    const schedule: EverySchedule = {
      kind: 'every',
      everyMs,
      nextRunAt: this.clock.now() + everyMs,
    }
    this.schedules.set(name, schedule)
    return schedule
  }

  peek(name: string): EverySchedule | undefined {
    const schedule = this.schedules.get(name)
    return schedule ? { ...schedule } : undefined
  }

  /** Fire each due schedule once, then jump nextRunAt past the current clock (skip missed). */
  tick(): string[] {
    const now = this.clock.now()
    const fired: string[] = []
    for (const [name, schedule] of this.schedules) {
      if (now < schedule.nextRunAt) continue
      const missed = Math.floor((now - schedule.nextRunAt) / schedule.everyMs)
      schedule.nextRunAt += (missed + 1) * schedule.everyMs
      this.onDue(name)
      fired.push(name)
    }
    return fired
  }
}
