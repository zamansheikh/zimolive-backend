import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { GamesService } from './games.service';

/**
 * Daily housekeeping for the games module. Game history (bets + rounds) is
 * high-volume — every bet is a row — so we keep only the last 30 days and
 * prune the rest each night. The wallet ledger is intentionally NOT touched
 * (money truth lives there for longer-term disputes).
 *
 * Runs at 03:00 server time, a low-traffic window. The delete is batched
 * inside the service so a large backlog can't lock the DB in one shot.
 */
@Injectable()
export class GamesCron {
  private readonly log = new Logger('GamesCron');

  /** Keep this many days of game history; older rows are purged nightly. */
  private static readonly RETENTION_DAYS = 30;

  constructor(private readonly games: GamesService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeHistory(): Promise<void> {
    try {
      const { bets, rounds } = await this.games.purgeOldHistory(
        GamesCron.RETENTION_DAYS,
      );
      if (bets > 0 || rounds > 0) {
        this.log.log(
          `Purged game history older than ${GamesCron.RETENTION_DAYS}d: ` +
            `${bets} bet(s), ${rounds} round(s)`,
        );
      }
    } catch (err: any) {
      this.log.error(
        `Game history purge failed: ${err?.message ?? err}`,
        err?.stack,
      );
    }
  }
}
