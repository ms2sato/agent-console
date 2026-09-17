// React 18.3 / @types/react 18.3 do not know the `inert` attribute, and
// React 18 drops a boolean `true` on an unknown attribute with a warning.
// The working form on this toolchain is the empty-string attribute
// (`inert=""` present / attribute absent), so the augmentation admits
// exactly that shape and nothing else -- never a boolean.
import 'react';

declare module 'react' {
  interface HTMLAttributes<T> {
    inert?: '';
  }
}
