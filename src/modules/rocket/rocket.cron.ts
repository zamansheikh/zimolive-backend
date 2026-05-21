import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { RocketService } from './rocket.service';

/**
 * Every 5 seconds: scan for rockets whose 10s countdown has elapsed
 * and fire the actual launch + reward distribution. The 5-second tick
 * keeps the worst-case lag (between countdown end and rewards landing)
 * under 5 seconds.
 *
 * Once daily at 00:30 Asia/Dhaka: clean up stale COUNTDOWN rows from
 * before a server crash. New gifts after midnight roll over naturally
 * via the `dayKey` upsert in addEnergy, so the daily reset is mostly
 * about housekeeping.
 */
@Injectable()
export class RocketCron {
  private readonly log = new Logger('RocketCron');
  private _ticks = 0;

  constructor(private readonly rocket: RocketService) {
    this.log.log('RocketCron constructed — sweeper will run every 5s');
  }

  @Cron(CronExpression.EVERY_5_SECONDS)
  async tick(): Promise<void> {
    // Liveness heartbeat: log the very first tick (proves the @Cron is
    // firing in this environment) then only hourly to avoid log spam.
    this._ticks += 1;
    if (this._ticks === 1 || this._ticks % 720 === 0) {
      this.log.log(`RocketCron alive (tick #${this._ticks})`);
    }
    try {
      const advanced = await this.rocket.sweepDueLaunches();
      if (advanced > 0) {
        this.log.log(`RocketCron advanced ${advanced} room(s)`);
      }
    } catch (err: any) {
      this.log.error(`Sweep failed: ${err?.message ?? err}`, err?.stack);
    }
  }

  /** 00:30 every day — Asia/Dhaka local time = 19:00 UTC. We use UTC
   *  for the cron expression since `@Cron` runs against the server
   *  timezone (UTC in production). This is best-effort cleanup; the
   *  real day rollover is implicit via `dayKey`. */
  @Cron('0 0 19 * * *')
  async dailyReset(): Promise<void> {
    try {
      const recovered = await this.rocket.dailyReset();
      if (recovered > 0) {
        this.log.log(`Recovered ${recovered} stale rocket(s) on daily reset`);
      }
    } catch (err: any) {
      this.log.error(`Daily reset failed: ${err?.message ?? err}`);
    }
  }
}
