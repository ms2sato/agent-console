# Header Navigation

## Problem

The desktop header grew one text link per destination (Review, Todo, Jobs, Agents, Artifacts, Repositories, Settings, Logout) and ran out of room. The mobile hamburger drifted from it at the same time: it lacked Review, Logout and the Maintenance warning. Two hand-maintained lists drift; this design keeps one.

## Decision table

| destination or action | desktop top level | desktop user menu | mobile hamburger | Settings hub page |
|---|---|---|---|---|
| Todo (+ badge) | do | not here | do: top group, badge | not here |
| Review (+ badge) | do | not here | do: top group, badge (gap closed) | not here |
| Artifacts | do (one-line move via placement) | not here | do: top group | not here |
| Maintenance warning | do: only when issues exist | not here | do: same component, same condition (gap closed) | not here |
| Notification bell | do | not here | do: always-visible cluster (unchanged) | not here |
| Create worktree `+` | do (unchanged) | not here | not here (unchanged, out of scope) | not here |
| Settings | not here | do: first item | do: menu group | is the page |
| Repositories | not here | do | do: menu group | do: existing pointer card stays |
| Agents | not here | do | do: menu group | do: existing pointer card stays |
| Jobs | not here | do | do: menu group | not here |
| Shared accounts | not here | do: multi-user only | do: multi-user only | do: existing card, multi-user only (unchanged) |
| Logout | not here | do: multi-user only, after a separator | do: multi-user only, last (gap closed) | not here |
| Username | not here | do: trigger text + menu heading, multi-user only | not here (no room; the menu is the whole nav) | not here |

## Single-source rule

`NAV_ITEMS` (`packages/client/src/components/header/nav-items.ts`) is the one list of header destinations. Each item carries a `placement` (`top` or `menu`), a `match` mode (`prefix` or `exact`), an optional `multiUserOnly` flag and an optional `badge`. The desktop user menu renders the `menu` group, the mobile hamburger renders every item (top group first), and both use the same active-path and auth-mode helpers. Moving an item between the desktop top level and the user menu is a flip of its `placement`.

Logout is an action, not a destination, so it is not in `NAV_ITEMS`; both menus call the same `useLogout` hook.

The mobile test suite pins parity: the set of links the hamburger renders equals `NAV_ITEMS` filtered by auth mode, plus `/maintenance` only when the validation query reports issues.

## Dependency note

`@radix-ui/react-dropdown-menu` is pinned exactly to 2.1.16. It is the newest 2.1.x whose transitive Radix packages equal the ones `react-dialog` 1.1.15 already resolves, so `bun.lock` keeps a single `dismissable-layer`. The 2.2.x line is deliberately not taken.
