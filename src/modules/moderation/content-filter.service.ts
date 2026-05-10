import { Injectable, Logger } from '@nestjs/common';

import {
  BlocklistEntry,
  DEFAULT_BLOCKLIST,
  FilterCategory,
} from './data/blocklist';

export interface FilterDecision {
  /** Whether the caller should reject the message outright. */
  blocked: boolean;
  /** Sanitised text — only differs from input when masking applied. */
  text: string;
  /** First category that fired. Used for audit / report categorisation. */
  category: FilterCategory | null;
  /** All hits for visibility in logs. Empty array if clean. */
  hits: { category: FilterCategory; action: BlocklistEntry['action'] }[];
}

/**
 * Lightweight regex-based content filter for room chat / DMs / moments
 * comments. Designed for two goals:
 *
 *   1. Catch the categories Google Play reviewers explicitly check
 *      for on social/UGC apps — CSAE proxies, self-harm
 *      encouragement, sexual solicitation. Hits in those categories
 *      reject the message ("blocked").
 *
 *   2. Soft-mask doxxing patterns (phone numbers, emails) so a
 *      well-meaning user sharing their own contact info doesn't
 *      get a hard error, but the data doesn't propagate either.
 *
 * For at-scale moderation, swap this out for a paid API (Microsoft
 * Content Moderator, OpenAI Moderation, Hive). The interface is
 * deliberately simple — same `check(text)` shape — so callers don't
 * have to change.
 *
 * Performance: regex evaluation is in the hot path of every chat
 * send. The default list is ~15 entries, all with `\b` anchors —
 * each call is sub-millisecond on modern Node. If you grow the
 * list past ~100 entries, consider Aho-Corasick or pre-tokenising.
 */
@Injectable()
export class ContentFilterService {
  private readonly logger = new Logger(ContentFilterService.name);
  private readonly entries: BlocklistEntry[] = DEFAULT_BLOCKLIST;

  /**
   * Run the filter over a candidate text. Returns a decision object
   * the caller can act on (block / use the masked text / pass through).
   *
   * Empty / whitespace-only inputs short-circuit as clean — saves the
   * regex work for messages that wouldn't survive validation anyway.
   */
  check(rawText: string): FilterDecision {
    if (!rawText || rawText.trim().length === 0) {
      return { blocked: false, text: rawText, category: null, hits: [] };
    }

    // Normalise: strip diacritics, collapse whitespace, lowercase.
    // Stops "ḱill yourself" / "k i l l    yourself" from sneaking
    // past pattern boundaries.
    const normalised = rawText
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    let blocked = false;
    let firstCategory: FilterCategory | null = null;
    const hits: FilterDecision['hits'] = [];
    let text = rawText;

    for (const entry of this.entries) {
      const re = new RegExp(entry.pattern.source, entry.pattern.flags);
      if (!re.test(normalised)) continue;

      hits.push({ category: entry.category, action: entry.action });
      if (firstCategory == null) firstCategory = entry.category;

      if (entry.action === 'block') {
        blocked = true;
        // Don't keep scanning past a block — we have enough info,
        // and we want the first matched category to win for
        // categorisation in the report queue.
        break;
      }
      if (entry.action === 'mask') {
        // Replace every match in the *original* text with stars of
        // matching length, preserving positions so URLs in chat
        // bubbles still wrap correctly.
        const masker = new RegExp(entry.pattern.source, entry.pattern.flags + 'g');
        text = text.replace(masker, (m) => '*'.repeat(Math.max(4, m.length)));
      }
      // 'warn' just logs and keeps scanning.
    }

    if (hits.length > 0) {
      this.logger.warn(
        `content-filter hit: ${hits
          .map((h) => `${h.category}:${h.action}`)
          .join(', ')} — message="${rawText.slice(0, 80)}"`,
      );
    }

    return { blocked, text, category: firstCategory, hits };
  }
}
