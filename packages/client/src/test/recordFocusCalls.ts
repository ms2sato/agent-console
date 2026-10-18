/**
 * Records `focus()` calls (receiver + options) by temporarily replacing the
 * prototype property. `spyOn(HTMLElement.prototype, 'focus')` throws under
 * happy-dom because `focus` is exposed as an accessor there, so the property
 * is swapped by hand. Call `restore()` in a `finally` / `afterEach`.
 */
export function recordFocusCalls(): {
  calls: Array<{ el: unknown; options: unknown }>;
  restore: () => void;
} {
  const calls: Array<{ el: unknown; options: unknown }> = [];
  let owner: object | null = HTMLElement.prototype;
  while (owner && !Object.getOwnPropertyDescriptor(owner, 'focus')) {
    owner = Object.getPrototypeOf(owner);
  }
  if (!owner) throw new Error('focus is not defined on the HTMLElement prototype chain');
  const original = Object.getOwnPropertyDescriptor(owner, 'focus')!;
  const target = owner;
  Object.defineProperty(target, 'focus', {
    configurable: true,
    writable: true,
    value: function (this: unknown, options?: unknown) {
      calls.push({ el: this, options });
    },
  });
  return { calls, restore: () => Object.defineProperty(target, 'focus', original) };
}
