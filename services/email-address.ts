/**
 * Recipient address of an email_apply job.
 *
 * The worker puts `payload.apply_email` into the MIME `To:` header, so anything that can end the header line
 * (CR, LF, NEL U+0085, LS U+2028, PS U+2029, VT, FF and the other control characters) or add a second
 * recipient (comma, semicolon, space, angle brackets, quotes, comments) must never get through. A queue
 * row is created by whoever calls the API, so this check runs here (queue guard, HTTP 400) and again in the
 * worker (worker/src/lib/emailAddress.ts, same rule; the worker copy exists because rows can reach
 * automation_queue without passing this API). The two copies share one list of test vectors.
 *
 * Rule (RFC 5322 "lite": one plain addr-spec, no display name, no quoted or bracketed forms, ASCII only):
 *   - 1 to 254 characters in total, local part at most 64;
 *   - local part: dot-atom of letters, digits and `_ % + -`, no leading, trailing or doubled dot;
 *   - domain: two or more labels of letters, digits and inner hyphens (1 to 63 characters each), the last one
 *     letters only (2 to 63), so no IP literals, no single-label hosts and no internationalised (non-ASCII)
 *     names (write those in punycode);
 *   - no surrounding whitespace is trimmed: a padded value is rejected, not repaired.
 * The web UI (src/lib/emailApply.ts, validateRecruiterEmail) accepts the same set after trimming.
 */
export const APPLY_EMAIL_MAX_LENGTH = 254

// Lookaheads bound the total (254) and the local part (64) before the structure is matched. `.` does not
// match line terminators, so the first lookahead alone already rejects CR, LF, U+2028 and U+2029; the
// character classes below are ASCII-only anyway.
export const APPLY_EMAIL_RE =
  /^(?=.{1,254}$)(?=[^@]{1,64}@)[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/

/** True only for a string that is exactly one plain email address (see the rule above). */
export function isValidApplyEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= APPLY_EMAIL_MAX_LENGTH && APPLY_EMAIL_RE.test(value)
}
