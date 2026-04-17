---
name: architectural-invariants
description: Catalog of cross-cutting architectural invariants that code must respect. Use when designing, implementing, or reviewing features that involve shared resources, persistence, or I/O symmetry. Ask each catalog question against the change.
---

# Architectural Invariants

This skill is a catalog of **meta-invariants** — cross-cutting architectural rules whose violation produces a characteristic class of bugs. Each invariant is stated abstractly, then followed by detection heuristics, concrete examples, and resolution patterns.

## How to Use

1. **During design/implementation**: for each invariant, ask "does this change interact with this invariant?" If yes, verify the invariant holds.
2. **During review**: mechanically walk the catalog against the change. Any "maybe" is a question to raise with the author.
3. **In acceptance check**: the Orchestrator explicitly checks each applicable invariant before approving a PR.

The catalog is deliberately short. Each entry is a high-leverage pattern whose violation is easy for humans to miss and hard to catch with per-file review.

---

## I-1. I/O Addressing Symmetry

**Rule.** For any persistent resource that is both written and read, the functions that determine *where to write* and *where to read* must produce the same value for the same identity — or their divergence must be explicit and justified.

**Important caveat.** "Write address = read address" is the *common* case, but not universal. Legitimate asymmetric designs include:

- **Primary/replica databases** — writes go to the primary, reads can go to replicas. Convergence is eventual, bounded by replication lag. The asymmetry is a conscious durability/performance trade-off.
- **Write-through caches** — writes hit both cache and backing store; reads can come from either. Consistency is enforced by the write path.
- **CQRS / event sourcing** — the command side writes to an event log; the query side reads from a denormalized projection built from that log. The two storage shapes differ by design.
- **Append-only logs with index** — appends go to the log file; reads can use an index that points into the log. Two different physical structures, one logical resource.
- **Sharded / partitioned storage** — the identity is hashed to pick a shard for both write and read, but different identities go to different physical locations.

The invariant is not "address must be textually equal" — it is "**for the same identity, the read must find the data that was written, modulo the consistency model the design explicitly commits to**". Asymmetry is fine when documented and bounded. Accidental asymmetry is the bug.

**Why it matters.** If the write-address and read-address diverge for the same identity *without an explicit consistency model*, you get silent fragmentation: writes go to location A, reads come from location B. The system "works" on the write side (no error), but reads return stale or missing data. Every reconnection/restart amplifies the problem.

### Domains where this applies

| Domain | Write side | Read side |
|--------|-----------|----------|
| Filesystem | `writeFile(path)` | `readFile(path)` — paths must converge per identity |
| Database | `INSERT INTO table_a` | `SELECT FROM table_b` — table identity must match |
| Cache | cache write key | cache read key |
| Message queue | publish topic | subscribe topic |
| Distributed storage | write consistency level + target | read consistency level + target |
| Cookie/Auth | `Set-Cookie` domain/path | request cookie scope |
| Log aggregation | log sink | query source |
| URL scheme | redirect URL | receiver URL |
| Memory / mmap | write offset calculation | read offset calculation |

### Detection heuristics

1. **Grep for pairs.** For every write-side call (`writeFile`, `INSERT`, `cache.set`, `publish`, etc.), find the corresponding read-side call (`readFile`, `SELECT`, `cache.get`, `subscribe`). Is the addressing function the same? If computed, do both compute identically?
2. **Silent fallback in addressing.** Any `?? defaultPath` or `|| fallbackKey` in the function that computes an address is a red flag — it means the address can differ based on runtime state.
3. **Multiple constructors for the same addresser.** If `new PathResolver(...)` or `new KeyBuilder(...)` appears in many places with different arguments, check that the arguments always resolve to the same value for the same identity.
4. **Divergence across restarts.** Does the addressing function depend on mutable runtime state (repo name, config, cache)? Across a server restart, does the *same identity* still yield the *same address*? If not — flag.
5. **Divergence across instances.** In multi-instance deployments, does the addressing function produce the same value on every instance for the same identity?

### Resolution patterns

- **Single source of truth.** One function (or module-level helper) computes the address. Everyone else calls it. No inline address construction.
- **Persist the address (or a stable key).** Don't recompute from possibly-drifting inputs on every access. Compute once at creation, persist, read forever.
- **Brand the type.** Use a type name that encodes the stability contract (e.g., `CanonicalOutputPath` vs generic `string`). Reviewers notice when that type is assembled by hand.
- **Explicit asymmetry.** If write and read addresses legitimately differ (primary/replica, write-through cache), make the asymmetry explicit in types and document the invariant that governs their convergence (eventual, bounded, etc.).

### Example: fragmentation bug caught by this invariant

Issue [#631](https://github.com/ms2sato/agent-console/issues/631). Worker output files fragmented across three directories because `SessionDataPathResolver` re-looked up `repositoryName` on each construction, silently fell back to `_quick/` when the lookup returned undefined. Writes and reads both went through the resolver, but the resolver produced different paths depending on when it was called.

**Review question that would have caught it**: *"The `getOutputFilePath(sessionId)` function is called on both the write side (PTY output flush) and the read side (history reconnect). Does it always return the same value for the same sessionId, across server restarts?"*

The answer at the time was "no" — and that single question surfaces the entire class of bug.

---

## I-2. Single Writer for Derived Values

**Rule.** If a value is computed from inputs via a rule, exactly one function implements that rule. All other code that needs the value calls that function — never reimplements the computation.

**Why it matters.** Duplicated computation drifts. Ten callers, ten subtly different copies of the logic → each evolves independently → silent behavior divergence. Especially dangerous when the computation involves path joining, key derivation, URL building, timestamp formatting, etc.

### Detection heuristics

1. **Grep for similar expressions.** If `path.join(config, 'subdir', id)` appears in 3+ places, someone is rolling their own copy of a computation.
2. **Inline `?? default` in computation.** If the default differs between call sites, the function is not canonical.
3. **Absence of an exported helper.** If no module exports `compute<Thing>(inputs)`, callers are duplicating.

### Resolution patterns

- **Extract a helper.** Name it what it computes (`computeSessionDataBaseDir`).
- **Make the helper the only writer.** Document it. Add a test. Add a grep-based invariant check to CI if the pattern is safety-critical.

---

## I-3. Identity Stability Across Time

**Rule.** A value that identifies a resource (sessionId, userId, filePath-from-identity, DB primary key) must remain stable across the resource's entire lifetime — including server restarts, process crashes, DB restores, and config migrations.

**Why it matters.** Identifiers are used in client caches, URL bookmarks, cross-system references. If the identifier changes for the same underlying resource, every consumer that cached the old identifier is broken.

### Detection heuristics

1. **Identifier computed from mutable state.** If `id = f(configRoot, userName, timestamp)` and any input can change, the identifier is not stable.
2. **Identifier derived from volatile runtime state.** Uptime, process PID, random number without persistence → not stable.
3. **Re-keying on rename.** Renaming a repository, user, or file should not change the identifier of things that reference it.

### Resolution patterns

- Generate identifiers at creation (UUID or similar), persist them, never recompute.
- Treat names/slugs as mutable aliases, identifiers as immutable keys.

---

## I-4. State Persistence Survives Process Lifecycle

**Rule.** Any state the user expects to survive a server restart MUST be persisted to durable storage before the operation that produced it returns success.

**Why it matters.** In-memory state is lost on crash/restart. If a user sees "success" for an operation but the state was only in memory, they've been lied to.

### Detection heuristics

1. **Success returned before persistence commits.** The flow returns 2xx or resolves a Promise before the DB write or fsync.
2. **Fire-and-forget writes.** `void persist(data)` without awaiting the result.
3. **Buffered writes without flush-on-shutdown.** Write-through caches or write buffers that don't drain on SIGTERM.

### Resolution patterns

- Await persistence before returning success.
- Register shutdown handlers that drain buffers.
- Test the crash/restart round-trip explicitly.

---

## I-5. Server as Source of Truth

**Rule.** Application state that affects behavior visible to other users (session status, worker output, templates, memos, etc.) lives on the server. Client state is either a cache of server state or purely transient UI state (dark mode, scroll position).

**Why it matters.** When the client owns state that should be shared, multi-device/multi-session flows break. Refreshes lose data. Collaboration becomes impossible.

### Detection heuristics

1. **`localStorage.setItem` holding user-meaningful data.** Templates, drafts, session config → should be server-backed.
2. **Client-generated IDs that are never reconciled server-side.** Client creates a UUID, uses it, but the server doesn't know.
3. **Optimistic writes that never confirm.** No error path if the server rejects.

### Resolution patterns

- Server is the single source for user-meaningful state.
- Client caches are clearly labeled as such (invalidation, TTL, refetch logic).
- `localStorage` restricted to transient UI preferences.

---

## I-6. Boundary Validation

**Rule.** Any value crossing a trust boundary (user input, external API response, job payload reconstructed after persistence, cross-process IPC) is validated before use.

**Why it matters.** Values from outside are not type-safe even if TypeScript says they are. A corrupted DB value can still type-check as `string`. A job payload from disk can contain any bytes. Trust the type system only for values that never left your process.

### Detection heuristics

1. **External data deserialized without a schema.** `JSON.parse(body)` used without `v.parse(Schema, ...)`.
2. **Filesystem paths derived from untrusted input without boundary check.** `path.join(userInput, ...)` can escape the intended directory.
3. **Numeric or enum fields read from DB without validation.** DB corruption silently becomes application state.

### Resolution patterns

- Validate with Valibot (or equivalent) at every trust boundary.
- For filesystem paths, resolve and then assert `startsWith(allowedRoot)`.
- For IDs coming from external sources, verify they exist in the expected registry.

---

## How to Add New Invariants

A new entry to this catalog should satisfy all of:

1. **Cross-cutting.** Applies across files, packages, or domains — not specific to one feature.
2. **High-leverage detection.** Knowing the pattern transforms "how would I even notice this?" into a mechanical check.
3. **Named failure mode.** You can describe the bug class in one sentence.
4. **At least one concrete past incident.** A real bug (from this project or common knowledge) that the invariant would have caught.

Format: `I-<N>. <Short name>`, followed by rule, why, detection heuristics, resolution patterns, concrete example.

## Integration With Other Skills

- `code-quality-standards` — per-code-unit quality (SRP, readability, etc.). Complementary: this skill is about cross-unit invariants.
- `test-standards` — how to test. Complementary: this skill names what MUST be tested (e.g., identity stability across restart).
- `orchestrator/acceptance-check.js` — runs this catalog as a required question during acceptance.
- `orchestrator/delegation-prompt.js` — injects relevant invariants into the agent's task prompt based on Issue content.
