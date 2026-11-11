import { Global, Injectable, Module } from '@nestjs/common';

/**
 * The app's clock. Every business rule that depends on "now" (time windows, the generator, the
 * board cursor) reads it here, so tests can pin the time like Laravel's `Carbon::setTestNow()`
 * without faking the timers the database driver relies on.
 */
@Injectable()
export class Clock {
  private fixed: number | null = null;

  now(): Date {
    return new Date(this.fixed ?? Date.now());
  }

  nowMs(): number {
    return this.fixed ?? Date.now();
  }

  /** Tests only: pin the time (`null` = real time again). */
  set(at: string | Date | null): void {
    this.fixed = at === null ? null : new Date(at).getTime();
  }
}

@Global()
@Module({ providers: [Clock], exports: [Clock] })
export class ClockModule {}
