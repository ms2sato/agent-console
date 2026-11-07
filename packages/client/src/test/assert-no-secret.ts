import type { QueryClient } from '@tanstack/react-query';

/**
 * Everything a secret could be sitting in after (or while) a request runs: each
 * mutation's variables and data, each query's data, and the DOM (text and the
 * `value` of every input, which is a property and not part of the markup).
 * Returns the places that contain `secret`, so an assertion can name them.
 */
export function findSecretHolders(queryClient: QueryClient, secret: string): string[] {
  const holders: string[] = [];
  const contains = (value: unknown) => (JSON.stringify(value ?? null) ?? '').includes(secret);
  for (const m of queryClient.getMutationCache().getAll()) {
    if (contains(m.state.variables)) holders.push('mutation variables');
    if (contains(m.state.data)) holders.push('mutation data');
  }
  for (const q of queryClient.getQueryCache().getAll()) {
    if (contains(q.state.data)) holders.push(`query ${JSON.stringify(q.queryKey)}`);
  }
  if ((document.body.textContent ?? '').includes(secret)) holders.push('DOM text');
  for (const input of Array.from(document.querySelectorAll('input, textarea'))) {
    if ((input as HTMLInputElement).value.includes(secret)) holders.push('DOM input value');
  }
  return holders;
}
