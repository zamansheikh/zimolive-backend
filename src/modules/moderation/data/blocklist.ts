/**
 * Default content blocklist.
 *
 * Categories follow the same enum as `ReportReason` so a hit on the
 * filter can produce a useful audit line + (later) auto-file a report
 * against the author. Each entry is a regex tested against the
 * lowercased + diacritic-stripped message; case-insensitive match.
 *
 * IMPORTANT: this is a *starter* list, not a comprehensive one.
 * Live-streaming apps at scale subscribe to a paid moderation service
 * (Microsoft Content Moderator, OpenAI Moderation, Hive, etc.) for
 * full coverage. For v1 + Google Play first submission, this file
 * gives you defensible "we have a filter" + catches the categories
 * Play reviewers explicitly look for (CSAE proxy, self-harm,
 * solicitation).
 *
 * To extend: add patterns to the array, ship a backend redeploy.
 * To override at runtime: load from a JSON file mounted via env
 * (left as a follow-up — see ContentFilterService).
 *
 * Ship rules for new patterns:
 *   • Use word-boundaries (`\b…\b`) so "scunthorpe" isn't flagged.
 *   • Test the pattern against the existing list before adding to
 *     avoid double-categorising (the first match wins).
 *   • Avoid putting slurs in source control directly — load those
 *     from an env-mounted file in production.
 */

export type FilterCategory =
  | 'csae' // child sexual abuse / exploitation proxies
  | 'sexual_solicitation'
  | 'self_harm'
  | 'violence'
  | 'doxxing'
  | 'profanity_severe';

export interface BlocklistEntry {
  /** Compiled regex tested against the normalised text. */
  pattern: RegExp;
  category: FilterCategory;
  /**
   * `block`  → reject the message; the user sees an error.
   * `mask`   → allow the message but replace the match with ****.
   * `warn`   → allow + log only; never user-visible. Reserved for
   *            patterns under tuning where false positives outweigh
   *            real hits.
   */
  action: 'block' | 'mask' | 'warn';
}

// ---- Helper to keep the list readable ----
const block = (pattern: RegExp, category: FilterCategory): BlocklistEntry => ({
  pattern,
  category,
  action: 'block',
});

export const DEFAULT_BLOCKLIST: BlocklistEntry[] = [
  // ------------------------------------------------------------------
  // CSAE proxies — co-occurrence of "minor"-class word + sexual word
  // in the same message. Single-word matches are deliberately AVOIDED
  // because most are too false-positive-prone (a parent asking about
  // their child shouldn't be flagged). Two-word adjacency is the
  // sweet spot.
  // ------------------------------------------------------------------
  block(
    /\b(child|kid|minor|underage|loli|shota|pre[\- ]?teen|teen)\b.{0,40}\b(sex|nude|naked|porn|fuck|horny|hot|sexy)\b/i,
    'csae',
  ),
  block(
    /\b(sex|nude|naked|porn|horny|hot|sexy)\b.{0,40}\b(child|kid|minor|underage|loli|shota|pre[\- ]?teen|teen)\b/i,
    'csae',
  ),
  // Explicit CSAM acronyms.
  block(/\b(cp|csam|cheese pizza)\b/i, 'csae'),

  // ------------------------------------------------------------------
  // Sexual solicitation — high-confidence phrases.
  // ------------------------------------------------------------------
  block(/\bsend (me )?nude(s)?\b/i, 'sexual_solicitation'),
  block(/\bsend (me )?(your )?pic(s|tures?)?\b.{0,20}\b(nude|naked|topless)\b/i, 'sexual_solicitation'),
  block(/\bdick pic(s)?\b/i, 'sexual_solicitation'),
  block(/\bshow (me )?(your )?(tits|boobs|ass|pussy|dick|cock)\b/i, 'sexual_solicitation'),
  block(/\b(want to|wanna) fuck\b/i, 'sexual_solicitation'),

  // ------------------------------------------------------------------
  // Self-harm encouragement aimed at others. Self-expression about
  // one's own struggles is NOT in scope for blocking — Google policy
  // distinguishes "encouraging others to self-harm" from "talking
  // about one's own mental health". Patterns here target the former.
  // ------------------------------------------------------------------
  block(/\b(kill|end) (your|ur) ?self\b/i, 'self_harm'),
  block(/\bkys\b/i, 'self_harm'),
  block(/\bgo die\b/i, 'self_harm'),
  block(/\bcommit suicide\b/i, 'self_harm'),
  block(/\bhang (yourself|urself)\b/i, 'self_harm'),

  // ------------------------------------------------------------------
  // Direct violent threats. Same caveat as self-harm — first-person
  // venting is fine; second-person threats are the target.
  // ------------------------------------------------------------------
  block(/\b(i('| a)m gonna|i will) (kill|murder|stab|shoot)\b/i, 'violence'),
  block(/\bdeath threat(s)?\b/i, 'violence'),

  // ------------------------------------------------------------------
  // Doxxing — sharing of contact data IN room chat is a frequent
  // grooming vector. Patterns intentionally LOOSE so masking
  // catches obfuscated cases (spaces, dots, "at"). Action is `mask`
  // not `block` so non-malicious cases (sharing your own phone with
  // a friend) just get redacted.
  // ------------------------------------------------------------------
  {
    pattern: /\b\+?\d{1,3}[\s.\-]?\(?\d{2,4}\)?[\s.\-]?\d{3,4}[\s.\-]?\d{3,4}\b/,
    category: 'doxxing',
    action: 'mask',
  },
  {
    pattern: /\b[a-z0-9._%+\-]+\s?(@|\[at\]|\(at\))\s?[a-z0-9.\-]+\.[a-z]{2,}\b/i,
    category: 'doxxing',
    action: 'mask',
  },
];
