/**
 * In-memory, single-use, TTL-bound, artifact-id-bound token store for the
 * HTML artifact viewer shell's header-blind-origin gate.
 *
 * Background (docs/design/html-artifacts.md §3.3 P6', "header-blind-origin
 * addendum"): browsers only attach `Sec-Fetch-*` (Fetch Metadata) headers to requests
 * whose target origin is potentially trustworthy (HTTPS, or localhost). A
 * plain-HTTP, non-localhost origin (e.g. a LAN IP) never gets them -- so
 * `routes/artifacts.ts`'s P6 gate cannot rely on `Sec-Fetch-Dest` alone to
 * distinguish "the shell's own genuine iframe load" from "anything else" on
 * such an origin. This module gives the shell a credential it mints itself
 * (`routes/artifacts-viewer.ts`) instead: possession of the 128 bits of
 * randomness IS the proof, nothing more.
 *
 * Explicitly NOT an authentication mechanism -- `authMiddleware` is
 * unchanged on both routes and remains the sole authority on WHO is asking.
 * A token proves only "this request was induced by a render of our own
 * shell", never WHO is making it.
 *
 * No persistence, no signing: a server restart invalidates every
 * outstanding token, which degrades to the pre-existing nested-shell
 * recovery path on a header-blind origin (an accepted residual, see
 * docs/design/html-artifacts.md §4).
 *
 * Sweep strategy: lazy, on every mint/consume call. No background timer --
 * the store's own callers pay the sweep cost, and it caps at the number of
 * live shell renders within one TTL window (60s), which is not a hot path.
 */
import { randomBytes } from 'crypto';

/**
 * Token time-to-live, in milliseconds, from mint time. See
 * docs/design/html-artifacts.md §4 for why 60s: long enough to cover a
 * shell render -> iframe subresource load round trip even under slow
 * network conditions, short enough that an unconsumed token is not a
 * long-lived credential.
 */
export const ARTIFACT_VIEWER_TOKEN_TTL_MS = 60_000;

interface TokenEntry {
  artifactId: string;
  expiresAt: number;
}

const tokens = new Map<string, TokenEntry>();

/** Delete every entry whose TTL has elapsed as of `now`. */
function sweepExpired(now: number): void {
  for (const [token, entry] of tokens) {
    if (entry.expiresAt <= now) {
      tokens.delete(token);
    }
  }
}

/**
 * Mint a fresh single-use token bound to `artifactId`, valid for
 * `ARTIFACT_VIEWER_TOKEN_TTL_MS` from `now()`. 128 bits of randomness
 * (`crypto.randomBytes(16)`), base64url-encoded -- URL-safe, usable
 * directly in a query string with no additional escaping required by the
 * encoding itself (callers still run it through the same
 * `encodeURIComponent` discipline as the artifact id, for defense in
 * depth).
 *
 * `now` is an injectable clock (defaults to `Date.now`) so callers can pin
 * TTL-boundary tests deterministically instead of sleeping.
 */
export function mintArtifactViewerToken(artifactId: string, now: () => number = Date.now): string {
  const currentTime = now();
  sweepExpired(currentTime);
  const token = randomBytes(16).toString('base64url');
  tokens.set(token, { artifactId, expiresAt: currentTime + ARTIFACT_VIEWER_TOKEN_TTL_MS });
  return token;
}

/**
 * Consume `token` if -- and only if -- it exists, is unexpired, and is
 * bound to `artifactId`. Single-use: a successful consume DELETES the
 * entry immediately, so a second identical call always returns `false`
 * (this is the property that closes the "open this URL in a new tab"
 * exfiltration path -- see the Architect ruling linked from
 * docs/design/html-artifacts.md §3.3 P6'-b).
 *
 * A token bound to a DIFFERENT artifact id never validates and is left
 * untouched (not deleted) -- it remains available to the artifact it
 * actually belongs to.
 *
 * `now` is an injectable clock (defaults to `Date.now`), matching
 * `mintArtifactViewerToken`.
 */
export function consumeArtifactViewerToken(token: string, artifactId: string, now: () => number = Date.now): boolean {
  const currentTime = now();
  sweepExpired(currentTime);
  const entry = tokens.get(token);
  if (!entry) {
    return false;
  }
  if (entry.expiresAt <= currentTime) {
    tokens.delete(token);
    return false;
  }
  if (entry.artifactId !== artifactId) {
    return false;
  }
  tokens.delete(token);
  return true;
}

/**
 * @internal Exported for testing -- clears every stored token. Guards
 * against cross-test state bleed within the same `bun:test` process
 * (`tokens` is a module-level singleton).
 */
export function _resetArtifactViewerTokensForTest(): void {
  tokens.clear();
}
