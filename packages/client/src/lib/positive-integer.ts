/**
 * The numeric core of "positive integer", hoisted out of
 * `EmbeddedAgentForm.tsx`'s `maxToolIterationsInput` / `contextWindowTokensInput`
 * checks so a third caller (the mid-run parameter-override control in
 * `EmbeddedAgentWorkerView.tsx`) does not re-derive the same rule a third
 * time. The two form fields additionally require their raw string input to
 * match `/^\d+$/` before calling this -- that shape check is a fact about a
 * TEXT input and stays local to each form; only the numeric rule and its
 * message are shared here.
 */
export function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

/** Message shown wherever `isPositiveInteger` rejects a value. */
export const POSITIVE_INTEGER_MESSAGE = 'Must be a positive integer';
