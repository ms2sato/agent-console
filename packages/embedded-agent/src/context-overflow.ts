import type { ProviderErrorDetail } from './providers/types.js';

/**
 * Classifies a provider's wire error as "the request exceeded the context
 * window" -- the trigger for the turn-path escape in `agent-loop`.
 *
 * # The asymmetry this is built around
 *
 * A false negative is safe: the escape does not fire and the turn ends in
 * `turn-error`, exactly as it does today. A false positive is dangerous: it
 * turns a genuine provider outage into a compaction, destroying conversation
 * in response to a problem compaction cannot solve. **Every rule here is
 * chosen to fail toward the first.**
 *
 * That is why this is an allowlist of measured observations rather than a
 * heuristic. A rule of the shape "large request + 4xx implies overflow" would
 * be shorter and would misfire on the Cloudflare row below -- an edge proxy
 * rejecting on body size, nothing to do with context.
 *
 * # Why structure alone is not the key
 *
 * The provider's structured fields narrow the FAMILY, but a provider's code
 * can be coarser than the condition we are detecting. `invalid_parameter_error`
 * covers every invalid parameter, not only an over-long input; keying on it
 * alone would classify unrelated parameter faults as overflow, which is the
 * dangerous direction. So an entry may carry a message discriminator that
 * narrows WITHIN the family it has already matched structurally.
 *
 * This is not the internal string-matching the codebase forbids. That rule is
 * about our own layers: the server must not parse an engine's prose to decide
 * what happened. Reading an external provider's error envelope at the system
 * boundary is validation of untrusted input, and it happens once -- the
 * envelope is parsed in the adapter and travels inward as `ProviderErrorDetail`.
 * Our own composed `message` string is never consulted here.
 *
 * # Absence is a verdict
 *
 * When `detail` is undefined the body was not the provider's JSON envelope --
 * an edge proxy's HTML, an unreadable body, a non-provider fault. Every entry
 * requires structure, so absence matches nothing and the answer is `false`
 * **without an exclusion rule existing for it**. The dangerous row is refused
 * by the shape of the check rather than by a list we have to keep complete.
 */

interface OverflowSignature {
  /** Which provider and model this was measured against, and when. */
  readonly provenance: string;
  /** Required. An entry with no status requirement would match too much. */
  readonly status: number;
  /** Matched against `detail.type` or `detail.code`, whichever is present. */
  readonly family: string;
  /**
   * Narrows within an already structurally-matched family. Present only when
   * the provider's own code is coarser than "the input was too long"; an entry
   * whose code already means exactly that needs none.
   */
  readonly discriminator?: RegExp;
}

/**
 * Measured observations only. Do not add an entry from documentation or from
 * a provider's changelog -- an unmeasured entry is a guess pointing in the
 * dangerous direction.
 */
const OVERFLOW_SIGNATURES: readonly OverflowSignature[] = [
  {
    // Measured 2026-08-29 against https://opencode.ai/zen/go/v1, model
    // `qwen3.8-flash`: HTTP 400, type `invalid_parameter_error`, message
    // `Range of input length should be [1, 983616]`.
    provenance: 'opencode zen go/v1, qwen3.8-flash, measured 2026-08-29',
    status: 400,
    family: 'invalid_parameter_error',
    // `invalid_parameter_error` is generic across every invalid parameter, so
    // the family alone would sweep in unrelated faults. The message carries
    // the only signal that says WHICH parameter: an input-length range.
    discriminator: /range of input length|input length|maximum context length|too many tokens/i,
  },
  {
    // The OpenAI-compatible code that means exactly this condition and nothing
    // else, so it needs no discriminator. Widely emitted by OpenAI-shaped
    // providers; retained as the family-level entry.
    provenance: 'OpenAI-compatible `context_length_exceeded`, industry-standard code',
    status: 400,
    family: 'context_length_exceeded',
  },
];

/**
 * True only when the provider's structured error matches a measured overflow
 * signature. See the module docstring for why absence of structure is `false`
 * rather than "unknown, try harder".
 */
export function isContextOverflowError(
  status: number | undefined,
  detail: ProviderErrorDetail | undefined,
): boolean {
  if (status === undefined || detail === undefined) return false;

  return OVERFLOW_SIGNATURES.some((sig) => {
    if (sig.status !== status) return false;
    // Either structured field may carry the family; providers disagree about
    // which one they populate.
    const familyMatches = detail.type === sig.family || detail.code === sig.family;
    if (!familyMatches) return false;
    if (sig.discriminator === undefined) return true;
    return sig.discriminator.test(detail.message);
  });
}
