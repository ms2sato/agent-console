# Terminal History Paging: Segmented Archive and Backwards Range Fetch

Refs: [#959](https://github.com/ms2sato/agent-console/issues/959) (this design), [#958](https://github.com/ms2sato/agent-console/issues/958) (row decorators / reader view), [#940](https://github.com/ms2sato/agent-console/issues/940) (renderer default flip), [#941](https://github.com/ms2sato/agent-console/issues/941) (legacy renderer removal, merged as PR #962), `docs/design/websocket-protocol.md`, `docs/design/labs-terminal-poc-roadmap.md`.

Status: draft for owner review.

This document specifies the replacement of destructive output-file truncation with gzip segment archival on the server, the move from live-file-relative to absolute cumulative stream offsets, an additive backwards-range protocol message, and the client-side scroll-to-top paging design for the next renderer (`labs/terminal-poc`).

Code references are to the worktree state after #962 (legacy renderer removed; the PoC store is the only terminal client).

## 1. Motivation

Today the server persists worker output to `outputs/<sessionId>/<workerId>.log` capped at `WORKER_OUTPUT_FILE_MAX_SIZE` (10MB, `server-config.ts:39`). On overflow, the oldest ~20% is destroyed: `truncateFile` keeps 80% (`worker-output-file.ts:275`) and rewrites the file in place (`worker-output-file.ts:291`). A browser reload — or the store's 15-minute idle eviction (`poc-terminal-store.ts:72`) — resets the client to whatever the retained window still holds. History older than the window is gone forever.

The owner's direction (settled in the #959 discussion, 2026-07-03): **the browser stays light (current window + whatever was paged in), while history remains reachable arbitrarily far back, bounded only by server-side archive retention.** The measured stream is ~34% plain text / ~66% ANSI redraw churn, so gzip archival is cheap; the earlier "do not hoard" retention stance was revised to "do not hoard *raw* — archive compressed".

Sequencing: this lands after the default flip and legacy removal (#940 → #941, both done), so there is exactly one terminal client to design for.

## 2. Current offset accounting (as-is)

Three offset series exist today, and they are **not** the same series:

1. **Live `output` messages** carry `worker.outputOffset`, an in-memory cumulative byte counter incremented per PTY chunk (`worker-manager.ts:477`, delivered at `:487`, wire format `session.ts:152`). It starts at 0 on worker creation (`worker-manager.ts:238,261`), is re-seeded from the *file size* on revived activation (Issue #769; `worker-manager.ts:319-325` and `:428-434`), and — critically — is **never rebased when the file is truncated**.
2. **`history` responses** carry `totalOffset = fileSize + pendingByteLength` (`worker-output-file.ts:353`), i.e. a live-file-relative value.
3. **`output-truncated`** rebases the client to the post-truncation file length: `truncateFile` → `onOutputTruncatedCallback(sessionId, workerId, trimmedBuffer.length)` (`worker-output-file.ts:296-298`), broadcast by `notifyWorkerOutputTruncated` (`routes.ts:202-225`, wired at `:297`).

Series 1 and 2 coincide only until the first truncation; afterwards `output` offsets run ahead of file offsets by the trimmed amount. The system tolerates this divergence through two resync valves:

- Server: `readHistoryWithOffset` returns the **full history** when `fromOffset > totalOffset` (`worker-output-file.ts:356-365`).
- Client: `handleHistory` resets the terminal when the response `offset < requestedFromOffset` (`poc-terminal-store.ts:496-503`); `output-truncated` bumps `lastOffset` and shows a banner (`:481-485`).

Paging backwards requires one coherent, monotone coordinate system. The divergence above is exactly what this design removes.

## 3. Offset accounting change: absolute cumulative stream offsets

### 3.1 Definition

After this change, every `offset` on the worker wire protocol means the same thing:

> **The absolute byte position in the worker's cumulative output stream since worker creation (or last worker restart).** Position 0 is the first byte the PTY ever emitted; the stream only grows; archival never rebases it.

The stream is physically stored as: **archived segments** (oldest) + **live file** + **pending flush buffer** (newest). A per-worker manifest (Section 4) records `liveBaseOffset`, the absolute position of the live file's first byte. Concretely:

- `output.offset` — unchanged mechanically (`worker.outputOffset` is already cumulative and never rebased); it becomes *correct by definition* instead of correct-until-truncation.
- `history.offset` — becomes `liveBaseOffset + fileSize + pendingByteLength` instead of `fileSize + pendingByteLength` (`worker-output-file.ts:353`).
- `history` gains an additive field `startOffset`: the absolute position of the first byte of `data`. The client needs it to know where its rendered window begins (the initial load is last-N-lines, `routes.ts:819` + `readLastNLines`, so the start is not otherwise knowable). `readLastNLines` computes it as `totalOffset - byteLength(returnedData)`.
- `getCurrentOffset` (`worker-output-file.ts:535-563`) returns `liveBaseOffset + fileSize`. Because revived activation seeds `worker.outputOffset` from it (`worker-manager.ts:319-325`), revival stays consistent with no further change.
- `request-history.fromOffset` — interpreted as absolute. Serving rule: **forward catch-up serves the live window only.**
  - `fromOffset >= liveBaseOffset`: serve from the live file at position `fromOffset - liveBaseOffset` (today's logic, `worker-output-file.ts:356-385`, shifted by the base).
  - `fromOffset < liveBaseOffset` (client evicted/away long enough that its window scrolled into the archive): do **not** stream the archive forward. Return the initial-load shape (last N lines) with an honest `startOffset > fromOffset`; older content is reachable via backwards paging.
  - `fromOffset > totalAbsoluteOffset` (stale/diverged client): same recent-window response. Note the direction: any window the server can return necessarily satisfies `startOffset <= totalAbsoluteOffset < fromOffset`, so the response's window lies entirely **below** the requested offset — the opposite sign from the archived-out case above. With absolute offsets this can only happen across a worker restart (offsets reset to 0); restart detection is handled authoritatively by the generation identifier (Section 3.4), and the `worker-restarted` app event (`poc-terminal-store.ts:349-356`) remains as a fast-path but is no longer load-bearing.
  - **Client resync predicate (covers both cases)**: a `history` response is a contiguous continuation only when `startOffset === requestedFromOffset`. On any mismatch — `startOffset > requestedFromOffset` (window begins above the request: archived-out) or `startOffset < requestedFromOffset` with the window ending below the request (stale/diverged) — the client resets its buffer and treats the payload as a fresh load. The predicate compares the response's absolute window position against the request; the stale/diverged direction generalizes the current `offset < requestedFromOffset` reset heuristic (`poc-terminal-store.ts:496-503`), which is that half of the check.

Note on the last two cases: serving the **last-N-lines recent window** where today's server serves the **full history** on `fromOffset > totalOffset` (`worker-output-file.ts:356-365`) is a **deliberate serving-behavior change, not a compatibility no-op**. It is an improvement — a bounded payload for a client that is about to reset its buffer anyway — and the client-side reset contract (detect, reset, treat as fresh load) is unchanged.

### 3.2 `output-truncated` disappears

Archival is not data loss and never rebases offsets, so the message has no remaining meaning. Removal plan:

- Delete the emission path: `truncateFile`'s callback invocation (`worker-output-file.ts:296-298`), `OutputTruncatedCallback` / `setOutputTruncatedCallback` (`worker-output-file.ts:18-30`), `notifyWorkerOutputTruncated` and its registration (`routes.ts:202-225`, `:296-298`, and the `REQUIRED_INIT_STEPS` entry at `:233`).
- Delete the type from `WorkerServerMessage` (`session.ts:157`) and from `WORKER_SERVER_MESSAGE_TYPES` (`session.ts:133`). **Do not reuse ordinal 6** for a future message.
- Delete the client handler (`poc-terminal-store.ts:481-485`). A stale browser tab running a pre-upgrade bundle keeps a dead handler for a message the server never sends — harmless.
- Update `websocket-protocol.md` and the roadmap's feature-inventory row for `output-truncated`.

### 3.3 Upgrade compatibility (pre-upgrade client offset vs post-upgrade server)

The client's `lastOffset` lives only in module memory (`poc-terminal-store.ts:113`); there is no persisted offset store. The upgrade scenario is therefore: a browser tab stays open across a server upgrade, reconnects, and sends `request-history { fromOffset: <pre-upgrade value> }` (`poc-terminal-store.ts:409-414`).

At upgrade time the manifest does not exist yet, so `liveBaseOffset` initializes to 0 and the absolute offset equals today's file-relative `totalOffset` — the old value is directly compatible. The one divergent case: the pre-upgrade server had truncated during the old incarnation, so the tab's `lastOffset` (fed by never-rebased `output` offsets) exceeds the file size. The `fromOffset > totalAbsoluteOffset` valve (Section 3.1) returns the recent window (a deliberate change from today's full-history response — see the note in Section 3.1); the client resets. This is the same resync dance that handles this case today — no migration code is required, only a migration **test** (Section 8).

There is also a server-side accounting wrinkle in the same scenario: a pre-upgrade destructively-truncated file with no manifest means `liveBaseOffset = 0` **undercounts** the true cumulative stream by the destroyed head bytes, and revived activation then reseeds `worker.outputOffset` from that undercounted `getCurrentOffset` value, baking the undercount into the live series. On its own this is untidy but internally consistent (all post-upgrade series agree with each other); it is **subsumed by the generation identifier** (Section 3.4): the first post-upgrade incarnation simply *defines* the initial epoch's offset baseline for that worker (the epoch minted at first manifest creation), and any client whose state disagrees resyncs on epoch mismatch instead of reasoning about offset magnitudes.

### 3.4 Worker generation identifier (epoch)

Absolute offsets restart at 0 on worker restart (Section 4.5), which reintroduces a coordinate-aliasing hazard: a client holding a pre-restart offset can find that value *numerically valid* in the new incarnation once the new stream grows past it. The `fromOffset > totalAbsoluteOffset` valve (Section 3.1) only fires while the stale offset is still ahead of the new stream; after that window closes, forward catch-up and — worse — **backwards paging would silently serve unrelated new-incarnation bytes as authoritative history**, with nothing incoherent on the wire to detect. The existing `worker-restarted` broadcast cannot close this hole alone: it rides the app WebSocket, a **separate connection** from the worker socket, and can be missed entirely (app-socket drop, worker socket reconnecting before the app socket, ordering races between the two connections). Offset-magnitude heuristics plus a best-effort broadcast are not a coordinate-system guarantee.

This design therefore adds a **per-worker generation identifier ("epoch")**:

- **Value: the incarnation's creation timestamp in milliseconds** (`Date.now()` at worker creation / restart). A new epoch is minted on every worker restart (the `restartWorker` / `resetWorkerOutput` path, Section 4.5). A timestamp — rather than a persisted counter — is unique across restarts *without depending on manifest persistence*: a lost or unparsable manifest cannot mint a reused epoch, because the replacement incarnation's timestamp differs from every prior one. Clock regression across restarts is tolerable because **inequality, not ordering, drives the mismatch check** — the client compares epochs for equality only, never for order.
- Recorded in the manifest (Section 4.2, `epoch` field) so reads can tag responses without consulting the worker object. A missing or unparsable manifest mints a fresh epoch from the current incarnation's creation timestamp — the first post-upgrade incarnation is the initial-epoch baseline (Section 3.3); manifest loss can never resurrect a previously used epoch value.
- Carried as an **additive field** `epoch: number` on every `history`, `output`, and `history-range` server message (Section 5.1).
- **Capture atomicity**: the epoch must be snapshotted together with the data and offset it tags, inside the per-worker serialization domain (Section 4.3). The live output callback (`WorkerCallbacks.onData`, `worker-types.ts:18`, emitted at `worker-manager.ts:477`) widens to `(data, offset, epoch)` captured at emit time; history and range reads capture the epoch under the same lock that performs the read; and the route (`routes.ts:821`) assembles a response only from values captured together. A response must never pair one incarnation's bytes with another incarnation's epoch.
- Client behavior on **epoch mismatch** (a message's epoch differs from the recorded one): the client **discards the mismatching payload entirely** — an `output` is only a tail chunk and a `history-range` starts at an arbitrary VT midpoint, so applying either as a "fresh load" would silently construct invalid terminal state. It then tears down the live window and all paged state, resets `lastOffset` / `oldestOffset`, records the new epoch, and issues a fresh `request-history` with initial-load semantics (`fromOffset` 0 / omitted). Until that history response applies, subsequent live `output` payloads are **queued, not applied**; when the history response arrives, the queue is replayed in order, dropping entries whose end position (`offset`) is `<=` the history response's `offset` (those bytes are already covered by the history payload). This extends the teardown the `worker-restarted` handler performs today (`poc-terminal-store.ts:349-356`), which is retained as a UX fast-path but is no longer load-bearing for correctness.

**Delivery guarantee on restart**: the epoch check alone cannot reach a client whose worker socket stays attached to the old worker object's callbacks — restart installs a new worker object without rebinding already-open sockets (`worker-lifecycle-manager.ts:403`, `:450`; callbacks bound per-connection at `routes.ts:590`), so such a client would receive no new-epoch message at all. Therefore **on worker restart the server closes all open worker WebSockets for that worker with a dedicated `WORKER_RESTARTED` (4001) close code**, forcing a reconnect; the reconnect lands on the new incarnation and receives the new epoch via the initial `history` response. The code must NOT be normal-closure (1000): the client treats 1000 as a deliberate no-reconnect close (the same `NO_RECONNECT_CLOSE_CODES` set that handles `SESSION_DELETED` / `SESSION_PAUSED`), which would strand the terminal at "disconnected"; 4001 is an RFC 6455 private-use code outside that set, so the client reconnects. The app-ws `worker-restarted` event remains a UX fast-path only (Section 4.5).

With the epoch check, offset validity is decided by `(epoch, offset)` pairs rather than by offset magnitude plus an out-of-band broadcast; the aliasing scenario above becomes structurally impossible, because the first response tagged with the new epoch forces a resync regardless of how the offsets compare numerically.

## 4. Segmented archive

### 4.1 Cut operation

`flushBuffer`'s size check (`worker-output-file.ts:249-252`) keeps its trigger (live file > `fileMaxSize`) but the action changes from destroy-oldest-20% to archive-oldest-20%:

1. Compute the slice point exactly as today: `currentSize - floor(fileMaxSize * 0.8)`, advanced to a UTF-8 character boundary by skipping continuation bytes (`worker-output-file.ts:280-287`). At defaults this yields ~2MB uncompressed per segment.
2. Gzip the head slice and write it to `outputs/<sessionId>/<workerId>.seg-<N>.log.gz` (write `*.tmp`, `fsync`, `rename`, `fsync` the directory — Section 4.3). `N` is a monotonically increasing sequence number from the manifest; it never resets or backfills, so pruning leaves gaps in `N` but order stays total. Note: the write-side gzip helper must be (re)introduced — current code imports only `gunzipSync` (`worker-output-file.ts:7`); the hibernation-era `.log.gz` support is read-only legacy compatibility (`worker-output-file.ts:103-121`).
3. Rewrite the live file to the remainder (write `<workerId>.log.tmp`, `fsync`, `rename`, `fsync` the directory — the current in-place `writeFile` at `worker-output-file.ts:291` is not crash-safe and is replaced).
4. No client notification (Section 3.2).

### 4.2 Manifest (sidecar JSON)

Per worker: `outputs/<sessionId>/<workerId>.segments.json`.

```json
{
  "version": 1,
  "epoch": 1782950400000,
  "liveBaseOffset": 4194304,
  "pendingCut": null,
  "segments": [
    { "seq": 0, "startOffset": 0,       "endOffset": 2097152, "bytes": 2097152, "gzBytes": 183214, "file": "w-abc.seg-0.log.gz" },
    { "seq": 1, "startOffset": 2097152, "endOffset": 4194304, "bytes": 2097152, "gzBytes": 190022, "file": "w-abc.seg-1.log.gz" }
  ]
}
```

`epoch` is the incarnation creation timestamp in milliseconds (Section 3.4). `pendingCut` is either `null` (no cut in flight) or `{ "bytes": <cut length>, "expectedLiveSizeAfter": <live-file size once step 3 completes> }` — both values are required for crash recovery to decide whether the live-file rewrite ran (Section 4.3).

**Why a sidecar rather than naming-convention-only:** absolute-range mapping needs each segment's *uncompressed* start/end without opening it (gzip's ISIZE footer is mod 2^32 and costs a read per file); `liveBaseOffset` must survive even when all segments are pruned; and the manifest is the anchor for crash recovery. The manifest is always written temp-then-rename with the `fsync` discipline of Section 4.3. If it is missing or unparsable, the worker degrades to today's semantics (`liveBaseOffset = 0`, no paging past the live file, a fresh epoch minted per Section 3.4) — never a hard failure.

Absolute-range mapping: a segment covers `[startOffset, endOffset)`; the live file covers `[liveBaseOffset, liveBaseOffset + fileSize)`; the pending buffer follows. `firstAvailableOffset = segments[0]?.startOffset ?? liveBaseOffset` (rises above 0 once retention prunes).

### 4.3 Crash safety (two-phase cut)

Ordering, with recovery meaning for a crash after each step:

1. Write + rename `seg-N.log.gz`. *(Crash here: orphan segment file not referenced by the manifest; its data is still fully present in the live file. Recovery: delete orphans whose `seq` is not in the manifest.)*
2. Write + rename the manifest with the new segment appended, `liveBaseOffset` advanced to the new segment's `endOffset`, and `pendingCut = { bytes: <cut length>, expectedLiveSizeAfter: <pre-cut live size> - <cut length> }`. *(Crash here: the manifest claims the cut but the live file still contains the duplicated head. Recovery: `pendingCut != null` → decide via step 3's guard.)*
3. Rewrite the live file without the head (temp + rename). *(Recovery decidability: because the serialization domain (below) excludes appends for the whole cut, the live-file size is stable across steps 2-4. Recovery compares it against the persisted `pendingCut.expectedLiveSizeAfter`: equal → step 3 completed, skip to step 4; `expectedLiveSizeAfter + pendingCut.bytes` → step 3 did not run, redo it. Without the persisted expected size this comparison would be undecidable — `bytes` alone cannot distinguish the pre-cut size from the completed size.)*
4. Write + rename the manifest with `pendingCut = null`. *(Crash here: safe — the manifest write is temp-then-rename, so the on-disk manifest is either still the step-2 version (`pendingCut != null`; recovery's size comparison sees step 3 already completed and falls through to redo step 4) or the completed version. No intermediate state is observable.)*

**Durability (`fsync`) requirements**: at the commit points the recovery logic depends on — the segment write (step 1) and every manifest write (steps 2 and 4, and the live-file rewrite in step 3) — the temp file is `fsync`ed **before** the `rename`, and the containing directory is `fsync`ed **after** the `rename`. Temp-write-plus-rename without these syncs is atomic against process crash but not against power loss: the rename can reach disk ahead of the data blocks, leaving a manifest that references a zero-length or torn segment. The cost is per-cut (a handful of syncs per ~2MB archived), not per-append — the hot append path is untouched.

Recovery runs lazily on first access to a worker's output (manifest load), before any read is served. **A single per-worker promise-chain lock forms one serialization domain covering: append/flush, the cut (steps 1-4), range reads, and reset/delete (Section 4.5).** Append/flush must be inside the domain, not just the cut/read pair: the current writer is **not** single-writer — both the size-threshold and timer paths launch unawaited `flushBuffer` calls and clear the shared buffer before the async file operations complete (`worker-output-file.ts:162`, `:197`) — so without the lock a second flush can append to the live file between cut steps 2 and 3 and have its bytes silently discarded by the step-3 rewrite. With flushes inside the domain, no append lands mid-cut and no read observes the intermediate state between steps 2 and 3.

### 4.4 Retention

- **Default: capped at 100 segments per worker** (~200MB raw / ~20MB gz at the default ~2MB segment size — Decisions, item 1). ANSI-heavy streams compress at roughly 10:1 (the 34%/66% measurement in #959), so the default cap costs on the order of 20MB of disk per long-running worker while keeping ~200MB of raw history reachable.
- Configurable via `WORKER_OUTPUT_MAX_SEGMENTS` (new `server-config.ts` entry, default `100`); setting `0` opts into unlimited retention. When the cap is exceeded after a cut, delete the oldest segment files and drop their manifest entries (manifest rewrite is the commit point; a crash between file-delete and manifest-rewrite leaves a missing file whose range is served as unavailable — the range response degrades to `hasMore: false`, Section 5.1).
- No retention UI in this issue (Section 9).

### 4.5 Lifecycle interactions

- **Session deletion**: `deleteSessionOutputs` removes the whole `outputs/<sessionId>` directory (`worker-output-file.ts:669-673`); segments and manifest live there — covered with no change. Quick sessions share the same resolver layout (`session-data-path-resolver.ts:28-30`) — covered.
- **Worker deletion**: `deleteWorkerOutput` currently deletes only `.log` and legacy `.log.gz` (`worker-output-file.ts:624-644`); extend it to delete `seg-*.log.gz` and the manifest.
- **Worker restart**: `restartWorker` calls `resetWorkerOutput` (`worker-lifecycle-manager.ts:408`) and re-creates the worker with `outputOffset: 0` (revived: false, `:436-438`). `resetWorkerOutput` (`worker-output-file.ts:570-607`) must also delete all segments and rewrite the manifest with a **new epoch minted** from the new incarnation's creation timestamp (Section 3.4) so the absolute stream genuinely restarts at 0 under a new generation. This restart-triggered deletion acquires the **same per-worker promise-chain lock** as appends, cuts, and range reads (Section 4.3), making deletion atomic with respect to in-flight range reads: a range read either completes against the old incarnation's files or begins after they are gone — it never observes a half-deleted state. In the same restart path, the server **closes all open worker WebSockets for the worker with the dedicated `WORKER_RESTARTED` (4001) close code** (Section 3.4 — not normal-closure, which the client treats as no-reconnect): restart installs a new worker object without rebinding already-attached sockets' callbacks (`worker-lifecycle-manager.ts:403`, `:450`), so without the forced reconnect an attached client would never receive a new-epoch message. The reconnect lands on the new incarnation and gets the new epoch via the initial `history`. Client-side, the `worker-restarted` app event already resets the terminal and `lastOffset` (`poc-terminal-store.ts:349-356`); it must additionally clear the paged-in window (Section 6), and it remains a UX fast-path only — the close-and-reconnect plus epoch mismatch (Section 3.4) covers any client that misses the app-ws event.
- **Hibernation / pause-resume**: pausing kills PTYs but preserves output files (`session-pause-resume-service.ts:105-113`); segments and manifest are equally preserved. Legacy hibernation-era `<workerId>.log.gz` files keep their existing read/migration path (`worker-output-file.ts:103-121`, `:220-243`); when one is migrated to `.log` on first write, its content is the start of the stream, so `liveBaseOffset = 0` remains correct. Range paging works on a hibernated session because the worker WebSocket restores the worker on connect (`routes.ts:754`) and range serving needs only file access.

## 5. Protocol addition: `request-history-range`

### 5.1 Messages

Client → Server (`WorkerClientMessage`, `session.ts:118-121`):

| Type | Payload | Description |
|------|---------|-------------|
| `request-history-range` | `{ requestId: number, beforeOffset: number, maxBytes?: number }` | Request history bytes strictly before absolute offset `beforeOffset`. `maxBytes` is a hint; the server applies its own cap. `requestId` is a per-connection client counter, echoed back for correlation. |

Server → Client (`WorkerServerMessage`, `session.ts:151-158`; add `'history-range': 8` to `WORKER_SERVER_MESSAGE_TYPES`):

| Type | Payload | Description |
|------|---------|-------------|
| `history-range` | `{ requestId: number, data: string, startOffset: number, endOffset: number, hasMore: boolean, epoch: number }` | `data` covers absolute `[startOffset, endOffset)` with `endOffset <= beforeOffset`. `hasMore` is `startOffset > firstAvailableOffset`. An unavailable range (pruned, or `beforeOffset <= firstAvailableOffset`) returns `data: ''`, `startOffset = endOffset = beforeOffset`, `hasMore: false`. `requestId` echoes the request. |

In the same change, the existing `output` and `history` server messages gain the same **additive** `epoch: number` field (Section 3.4); a client compares it against its recorded epoch and resets on mismatch. The field is additive on all three messages — pre-upgrade clients ignore it.

**Revised `history` shape (full)**: `{ data: string, offset: number, startOffset: number, epoch: number, timedOut?: true }` — `offset` is the absolute end of the returned window (Section 3.1), `startOffset` the absolute start of `data` (new, Section 3.1), `epoch` per Section 3.4, `timedOut` unchanged from today. Client predicate distinguishing initial from incremental responses: on an initial load the client has no prior window and always applies the payload as a fresh load; on a forward catch-up (`request-history` with a `fromOffset`), the response is an incremental continuation appended in place **only when `startOffset === requestedFromOffset`** — any other window position triggers the resync reset (Section 3.1 resync predicate).

**Input validation**: `requestId`, `beforeOffset`, `maxBytes`, and every other client-supplied numeric field must be **non-negative safe integers** (`Number.isSafeInteger(v) && v >= 0`); server-emitted `epoch` / offset fields satisfy the same constraint by construction. This is boundary-of-system validation on external input. The server answers an invalid `request-history-range` with the unavailable-range shape (`data: ''`, `hasMore: false`, echoing `requestId` when it is itself valid) rather than erroring the socket — defensive, and indistinguishable from a pruned range to the client.

**Response correlation and contiguity**: the client applies a `history-range` response only when **all three** hold: (a) `requestId` matches the single in-flight range request, (b) `epoch` matches the recorded epoch, and (c) `endOffset === oldestOffset` — the response is contiguous with the current window top. Anything else is **discarded**: a late response surviving a same-epoch reset or an eviction would otherwise be prepended at the wrong position. The `HISTORY_LOAD_FAILED` error path for range requests carries the same `requestId`, so the client can clear the matching `loadingOlder` flag without guessing which request failed.

**New-client / old-server compatibility**: an old server does not recognize `request-history-range` — the message falls through the worker WS handler (`routes.ts:804-907` has no branch for it) and no range response ever arrives, which would leave `loadingOlder` stuck. The client therefore arms a **bounded 5s timeout** per range request; if no matching `history-range` (or error) arrives, it marks paging **unsupported for this connection**: further upward fetch is disabled and nothing is rendered in place of older history — a silent degrade to today's behavior. The mark is per-connection; a reconnect (which may land on an upgraded server) probes again. This also covers a server rollback mid-session.

**Missing segment file (ENOENT)**: if a manifest-referenced segment file is absent on disk — the crash window between retention's file-delete and manifest-rewrite (Section 4.4), or a prune racing the read — the range read treats it exactly as the unavailable-range case above (`data: ''`, `hasMore: false`). Availability is **filesystem-driven, not manifest-driven**: the manifest is a map, and the file's absence is authoritative.

Handled in the worker WS `onMessage` next to the existing `request-history` branch (`routes.ts:804-907`), with the same 5s timeout guard and an equivalent error path (`HISTORY_LOAD_FAILED`).

### 5.2 Serving rules

- **One storage unit per response — the server clamps to a single segment (or the live file) and never stitches across a boundary.** Justification: (a) each response costs at most one gunzip of one ~2MB segment; (b) the mapping code is a lookup, not a multi-file scatter-gather; (c) the client's loop is already incremental — a short response simply triggers the next `request-history-range` with `beforeOffset = startOffset`, so boundary clamping costs one extra round trip at worst, invisible behind scroll physics. The client must treat `startOffset`/`endOffset` as authoritative and never assume `endOffset - startOffset == maxBytes`.
- Within the unit, serve the trailing `min(maxBytes, SERVER_RANGE_CAP)` bytes ending at `min(beforeOffset, unitEnd)`. `SERVER_RANGE_CAP` = 256KB (new config, `WORKER_OUTPUT_RANGE_MAX_BYTES`).
- **Boundary hygiene**: `startOffset` is always advanced to a UTF-8 character boundary (same continuation-byte skip as `worker-output-file.ts:285-287`). Best-effort newline alignment: advance `startOffset` to the byte after the first `\n` within the first 4KB of the slice, if one exists — this makes chunk seams start at a line head, which materially improves the client's replay quality for line-flow content. (Segment *cut* points from Section 4.1 are UTF-8-aligned only; the read side does the newline cosmetics.)
- **Decompression cost**: use async `node:zlib` `gunzip` (promisified), not `gunzipSync`, per the backend async-over-sync rule — a 2MB segment is single-digit-ms work but there is no reason to block the event loop. Because a 2MB segment serves ~8 consecutive 256KB pages, keep a **per-worker, single-entry decompressed-segment cache** (invalidated on prune/reset/delete); a paging burst then costs one gunzip per segment, not per page. Memory bound: one uncompressed segment (~2MB) per actively-paging worker, dropped with the entry on a short TTL (30s). **Concurrency pattern**: the cache slot stores `{ seq, promise }` — the promise of the decompressed Buffer, installed *before* the gunzip starts, so concurrent readers of the same segment share one inflation. A caller captures the slot once, validates that the captured `seq` is the segment it needs before use, and then uses **only its own captured promise's result — never re-reading the shared slot after an `await`**, because the slot may have been invalidated or replaced with a different segment while the caller was suspended.

## 6. Client design (next renderer)

### 6.1 Trigger and fetch loop

`PocTerminalView`'s native scroll container (`handleScroll` body at `PocTerminalView.tsx:239`, wired to `onScroll` at `:533`) gains a top-edge check in the existing `onScroll` handler: when `scrollTop < ~2 viewport-heights`, `bufferType === 'normal'` (alt-screen scroll is forwarded to the app, `PocTerminalView.tsx:326`), no range request is in flight, paging is not marked unsupported for the connection (Section 5.1), the paged-window cap has not paused fetching (Section 6.4), and `oldestOffset > 0` with `hasMore` not exhausted → call a new store method `requestOlderHistory()`.

Store state added:

- `oldestOffset`: absolute start of everything currently represented (seeded by the new `history.startOffset` on initial load, moved down by each `history-range.startOffset`).
- `pagedChunks: PocRow[][]` (deque, oldest first) + `pagedRowCount`, `hasMoreHistory: boolean`, `loadingOlder: boolean` (surfaced in the snapshot alongside `loadingHistory`, `poc-terminal-store.ts:43`), `pagingUnsupported: boolean` (per-connection, Section 5.1), and the in-flight `requestId`.

Requests chain contiguously: `request-history-range { requestId, beforeOffset: oldestOffset, maxBytes: 262144 }`; the response's `startOffset` becomes the next `beforeOffset`. Contiguity with the live window is structural — the first request starts exactly at the initial window's `startOffset` — and is verified per-response by the `endOffset === oldestOffset` acceptance rule (Section 5.1).

### 6.2 Throwaway headless VT replay

ANSI streams cannot be replayed from an arbitrary midpoint (order-dependent cursor/screen state), so each fetched chunk is rendered by a **throwaway** `@xterm/headless` `Terminal` created per chunk and disposed immediately:

- Construct with the live terminal's current `cols` (wrap parity with the visible window), a small `rows` (e.g. 24), and `scrollback: 100_000`. This is a fixed generous bound, not a "typical case" estimate: the true worst case for a 256KB chunk is one row per byte (newline-heavy output → 262,144 rows), which no comfortable scrollback covers. **Overflow degradation loop**: after replay, if the throwaway buffer's length has reached the scrollback cap, rows were silently dropped from the top and the replay is not authoritative — discard it and re-request the same range with `maxBytes` quartered (256KB → 64KB → 16KB, floor 16KB). At 16KB even the one-byte-per-row worst case (16,384 rows) fits within the 100k scrollback, so the loop structurally terminates within two degradation steps.
- Write `processOutput(data)` — the same `stripSystemMessages` / `stripScrollbackClear` filter pipeline the live store applies (`poc-terminal-store.ts:277-280`), so paged rows match live rows in content policy. Known limitation: filters straddling a *range* boundary can leak fragments, the same pre-existing chunk-boundary gap the roadmap documents for `output` messages; newline alignment (Section 5.2) reduces exposure.
- After the write callback, extract rows via the same `extractRow` path used by `rebuildSnapshot` (`poc-terminal-store.ts:600-606`) — chunk replay always uses `extractRow`, **never** `extractRowWithCursor`: paged chunks are settled history with no cursor to bake in. Keep all scrollback rows (`y < baseY`) **plus the settled prefix of the final screen — rows up to and including the cursor row, with trailing blank rows trimmed**. Rows below the cursor are the volatile screen region and are discarded. For line-flow output this keeps exactly the chunk's tail; for TUI redraw churn the result is approximate by design (acknowledged in #959 — the archive pages through what was drawn; "what was said" belongs to #958's reader view).
- Dispose the throwaway terminal.

**Terminal resize**: paged chunks are replayed at fetch-time `cols` and are **not** rebuilt when the live terminal resizes — mixing rows wrapped at different widths would corrupt row geometry and the wrapped-line link windows. On any `cols` change, the store **drops all paged chunks**: `pagedChunks` / `pagedRowCount` reset, `oldestOffset` returns to the live window's `startOffset`, `hasMoreHistory` returns to `true`. The user re-pages if needed, and re-fetched chunks replay at the new width. This is the simple-and-correct choice; retaining the raw chunk bytes and re-replaying them on resize is noted as future work.

### 6.3 Prepend, keys, row cache, and anchoring

- The live `rowCache` (`poc-terminal-store.ts:126-129`) and `rebuildSnapshot` remain untouched: paged rows never enter the live buffer or its cache. The snapshot's `rows` becomes `[...pagedChunks.flat(), ...liveRows]`.
- **Keys**: live rows use the buffer index `y >= 0`; paged rows use negative keys allocated downward (newest paged chunk gets `-1 .. -n`, the next older chunk continues below), stable for the chunk's lifetime. Allocation rule: a single **monotonically decreasing counter** per store instance hands out negative keys; it is never reset and keys are never reused for the instance's lifetime — eviction drops rows but **never returns their keys to the pool**, so a chunk re-fetched after eviction gets fresh keys and can never collide with a still-mounted row. React list identity and `React.memo` reuse then work unchanged. Cursor rendering is unaffected — the cursor is baked into the live row via `extractRowWithCursor` (`poc-terminal-store.ts:604`), not positioned by array index. Note for the implementation PR: `PocRow.key`'s JSDoc currently reads "absolute row index" and must be updated to cover these synthetic negative ids.
- **Scroll anchoring**: on prepend (and on eviction), the view preserves an **anchor row** rather than a whole-container `scrollHeight` delta. In a layout effect, before the row-array change commits, it records the bounding-rect top of the first currently-rendered row (identified by its stable key, above); after the commit, it adjusts `scrollTop` by the measured position delta of **that same keyed row**. A whole-container `scrollHeight` delta is incorrect whenever a live append lands in the same commit as the prepend — bottom growth inflates the delta and over-scrolls the viewport — whereas a keyed anchor row is immune to concurrent bottom growth by construction. The scroll container **must set `overflow-anchor: none`** as part of this design: the browser default (`overflow-anchor: auto`) runs its own anchoring heuristic in the same frame and would race the manual adjustment. Effect ordering: the existing bottom-follow layout effect (`PocTerminalView.tsx:222-236`) and the new prepend-anchor effect have mutually exclusive firing conditions by construction (pinned-to-bottom vs. top-edge prepend), but the prepend-anchor effect must run first, and both effects must guard against firing together in the degenerate case where the content is shorter than the viewport (the view is simultaneously "at top" and "at bottom").
- **Execution note (as implemented)**: the shipped anchoring deviates from the keyed-rect technique above in one approved way and adds two rules discovered during the eviction-cannibalization fix:
  - **Fixed-row-height arithmetic anchor.** Every rendered row is pinned to a fixed `LINE_HEIGHT_PX`, so a prepend or eviction of N rows at the top shifts all existing content by exactly `N * LINE_HEIGHT_PX`. The compensation is therefore computed arithmetically from the paged-row-count delta instead of measuring a keyed anchor row's bounding rect. This is the fixed-row-height specialization of the keyed-anchor technique: it retains the property that matters (immunity to concurrent bottom growth, because the delta is derived from the top-side row count only) at lower cost. The store publishes the paged row counts (`pagedRowCount` / `pagedTopChunkRowCount`) exclusively from the same snapshot rebuild that publishes `rows`, so the count the effect keys on is always in lockstep with the DOM; publishing a count ahead of the rows would make the effect compensate against a DOM that does not contain them yet.
  - **Pre-commit base rule.** The compensation target is `preCommitScrollTop + delta * LINE_HEIGHT_PX`, where `preCommitScrollTop` is captured during render, before the row-array change commits. On a DOM shrink (eviction) the browser clamps `scrollTop` to the new maximum before layout effects run; basing the compensation on the post-commit (clamped) value under-compensates, lands the viewport at 0 — inside the Section 6.1 fetch trigger — and makes eviction self-defeat via an instant re-fetch plus a visible jump. The pre-commit base preserves the user's exact position and restores the structural invariant that the eviction threshold (chunk height + 2 viewport-heights) minus the chunk height lands exactly at the fetch-trigger boundary, never inside it. Growth (prepend) never clamps, so both bases coincide there.
  - **Programmatic-scroll gating and the same-value-unflag rule.** All programmatic `scrollTop` writes (anchor compensation, bottom-follow pin, jump-to-bottom) are flagged, and the Section 6.4 eviction check is skipped for the scroll event such a write fires — eviction runs only for genuine user scrolling. Because a write whose clamped result equals the current value fires no scroll event, the flag is unset immediately in that case; otherwise the stale flag would suppress the eviction check on the next genuine user scroll event.
- **Links and #958 decorators**: `detectRowLinks` runs over each replayed chunk with the same wrapped-line-window logic as `rebuildSnapshot` (`poc-terminal-store.ts:619-631`). Caveat, mirroring the filter caveat in Section 6.2: detection is per-chunk-isolated, so a URL whose wrapped continuation crosses a chunk↔chunk or chunk↔live boundary is missed or split at the seam. Acceptable for v1; if dogfood shows it matters, the replay can carry a one-row overlap window across the boundary purely for detection (the overlap row itself is not rendered twice). The row extraction + link detection + (future) #958 tier-1 classification/restyle steps are factored into one shared **row pipeline** function used by both `rebuildSnapshot` and the chunk replay, so decorators apply to paged-in rows by construction rather than by parallel implementation. This refactor is a prerequisite noted for the #958 implementation.

### 6.4 Paged-window memory cap and eviction

The paged window is droppable and re-fetchable (server keeps everything), so the cap can be aggressive:

- Cap: `MAX_PAGED_ROWS` ≈ 15,000 rows (≈ 3× the live `SCROLLBACK` of 5,000, `poc-terminal-store.ts:67`), a single constant beside the store's other timings.
- **Cap enforcement — fetch refusal, not eviction pressure**: at the cap, further upward fetch is **refused** (the Section 6.1 trigger goes inert) and a small inline notice row renders at the top of the paged window: "older history paused — scroll down to release memory, then page again". Enforcement happens at the moment of fetch; the design does not rely on eviction keeping pace with a viewport that is parked at the very top it would need to evict, so continuous upward paging cannot grow memory without bound.
- **Eviction (top-side only)**: the topmost chunk is evicted only when the viewport has moved **2+ viewport-heights below it** — eviction never removes content near the viewport. Evicting raises `oldestOffset` to the evicted boundary, returns `hasMoreHistory` to `true`, and restores cap headroom, re-enabling fetch; scrolling up again re-fetches. Apply the same anchor-row scroll compensation as prepend (Section 6.3). **No bottom-side eviction**: the live window is the primary content and is never sacrificed for paged history.
- Full teardown of paged state on: `worker-restarted` (`poc-terminal-store.ts:349-356`), epoch mismatch (Section 3.4), terminal reset in the resync path (Section 3.1), terminal `cols` resize (Section 6.2), and instance disposal (idle TTL / LRU eviction, `poc-terminal-store.ts:336-343`, `:680-693` — paged rows die with the instance, by design).

## 7. Edge cases

- **Fetch during active output**: paging touches the top edge, live output the bottom; absolute offsets make them independent. A cut can migrate bytes from the live file into a new segment between two page requests — the per-worker lock (Section 4.3) serializes appends, cuts, and reads, and the manifest lookup happens inside the lock, so a request is served from wherever the range lives at that moment. The client's anchoring measures a keyed anchor row's DOM position (Section 6.3), so simultaneous append + prepend in one frame stays stable.
- **Worker restart / output reset**: covered in Section 4.5; the invariant is that `resetWorkerOutput` and restart drop *all* content storage (live file + segments), rewrite the manifest with a new epoch minted (Section 3.4), close the worker's open WebSockets, and both offset series restart at 0 together under the new epoch. (**Worker deletion**, by contrast, removes the manifest too — the worker identity itself is gone.)
- **Multi-client concurrent paging**: range serving is stateless per request (all paging cursor state lives in each client's store); the only shared server object is the single-entry decompressed-segment cache, which is read-only shared and safe. N clients paging different segments of the same worker degrade the cache to per-request gunzip — acceptable.
- **Quick sessions**: identical storage layout and deletion path (Section 4.5); no special handling.
- **Hibernated sessions**: paging works after the connect-time restore (Section 4.5); revived offset seeding stays absolute via the updated `getCurrentOffset` (Section 3.1).
- **Range request while a legacy `<workerId>.log.gz` (hibernation-era) is still un-migrated**: the manager already decompresses it for reads (`worker-output-file.ts:347-350`); it is the whole stream at base 0, so range mapping treats it as the live file. No segments can exist alongside it (segments are only created by the new write path, which migrates first, `worker-output-file.ts:220-243`).

## 8. Testing plan

**Unit — server accounting and segmentation** (extend `packages/server/src/lib/__tests__/worker-output-file.test.ts`, config-injected small sizes via `WorkerOutputFileConfig`, `worker-output-file.ts:55-59`):
- Cut produces a segment + manifest with correct absolute ranges; UTF-8 boundary respected for multi-byte content spanning the cut point.
- `history.offset` / `history.startOffset` / `getCurrentOffset` are absolute across multiple cuts; `output` offsets (via a simulated `worker.outputOffset`) match `history` offsets after cuts.
- Crash recovery: manifest with `pendingCut != null` + live file at `expectedLiveSizeAfter + bytes` → redo step 3; live file already at `expectedLiveSizeAfter` → step 3 skipped, manifest finalized; orphan segment file → cleanup; completed state → no-op (idempotence).
- Lock scope: a flush racing a cut never appends between cut steps 2 and 3 (no byte loss); a flush racing `resetWorkerOutput` / delete is serialized.
- Range serving: within live file; within a gz segment (round-trips through real gzip); clamped at segment↔live and segment↔segment boundaries; `maxBytes` and server cap; newline alignment; pruned/unavailable range → empty + `hasMore: false`; `hasMore` correctness at `firstAvailableOffset`; `requestId` echoed on success and on the error shape; invalid numeric payloads (negative, non-integer, unsafe-integer) → the unavailable shape, no throw.
- Epoch: a missing manifest mints a fresh creation-timestamp epoch (never a reused prior value); persisted across manifest rewrites; `resetWorkerOutput` mints a new epoch distinct from the old across repeated resets; carried on `history` / `history-range` responses; comparison is equality-only (a clock-regressed new epoch still mismatches the old).
- `resetWorkerOutput` clears segments and rewrites the manifest (new epoch minted); `deleteWorkerOutput` removes segments + manifest; `deleteSessionOutputs` leaves nothing.
- ENOENT fallback: manifest references a segment whose file is missing → range response is the unavailable shape (`data: ''`, `hasMore: false`), no throw.
- Legacy `.log.gz` migration still passes existing tests, and a range request against an un-migrated legacy file serves at base 0.

**Unit — client store** (extend `packages/client/src/labs/terminal-poc/__tests__/`, mock WS as existing store tests do):
- `requestOlderHistory` stamps a fresh `requestId` and chains `beforeOffset` from response `startOffset`; in-flight guard; `hasMore` stop condition.
- Response acceptance: a `history-range` with a stale `requestId`, a mismatched epoch, or `endOffset !== oldestOffset` (non-contiguous, e.g. after an eviction) is discarded, and the matching `loadingOlder` flag clears only on the correlated response/error.
- Range-request timeout: no `history-range` within 5s → `pagingUnsupported` set for the connection, no further fetches; cleared on reconnect.
- Replay extraction: line-flow fixture (rows exactly match expected text, trailing blanks trimmed), TUI-churn fixture (no crash, volatile region discarded), wrapped-URL chunk (link detection parity with live pipeline).
- Replay overflow: a newline-heavy fixture that fills the throwaway scrollback triggers the degradation loop (re-request at `maxBytes/4`, floor 16KB) and never commits a truncated replay.
- Prepend keys stable and unique vs. live keys; decorator/row-pipeline applied to paged rows (shared-pipeline test).
- Eviction and cap: at `MAX_PAGED_ROWS` further fetch is refused and the notice row is present; moving the viewport 2+ viewport-heights below the top chunk evicts it, restores `oldestOffset` to the evicted boundary, and re-enables fetch; re-fetch works.
- Anchoring: prepend concurrent with a bottom append compensates by the anchor row's position delta (viewport visually stable), not by whole-container `scrollHeight`.
- `worker-restarted`, resync-reset, and `cols` resize clear paged state (resize also restores `oldestOffset` / `hasMoreHistory`).
- Epoch mismatch on any of `output` / `history` / `history-range` discards the mismatching payload (never applies it), clears live + paged state, resets offsets, records the new epoch, and issues a fresh initial `request-history`; live `output` arriving before that history response is queued and replayed after it, dropping entries whose `offset` is `<=` the history's `offset` — including the aliasing fixture: a stale `beforeOffset` that is numerically valid in the new epoch must trigger a reset, never a prepend of aliased data.

**Integration (wire)** (server WS route tests alongside existing `routes` tests): `request-history-range` over a real upgrade path; range fetch racing live `output` (assert offset coherence); two connections paging the same worker; hibernated worker restore + immediate range request; worker restart between two range requests (assert the open worker sockets are closed with the `WORKER_RESTARTED` (4001) close code and the post-reconnect response carries the new epoch); timeout path returns the error shape with the request's `requestId`.

**E2E** (`e2e/`): generate a multi-MB session (looped line output past several cut points), reload the page, deep-scroll to the earliest content: assert (a) earliest line reachable, (b) scroll position stable across each prepend (no jump), (c) no duplicated/garbled seam lines for line-flow content, (d) memory: paged window capped (indirectly via row count).

**Migration test**: simulate the pre-upgrade divergence — build a live file, apply the *old* truncation semantics to it (head-trimmed file, client `lastOffset` larger than file size, no manifest) — then run the new server against it: `request-history fromOffset=<stale>` must return the recent window lying entirely below the request (`startOffset < fromOffset`, per the Section 3.1 direction), and the store's resync predicate (`startOffset !== requestedFromOffset`) must reset and continue (no loop, no crash).

## 9. Out of scope

- **Reader-view / message-unit paging** (#958 tier 2): paging through extracted conversation units instead of drawn bytes. This design deliberately keeps the server archive raw-bytes-only so that layer can be built on top later; the only #958 coupling here is the shared row pipeline (Section 6.3).
- **Retention UI / per-session retention policy**: only the `WORKER_OUTPUT_MAX_SEGMENTS` env knob ships; any UI is a separate issue.
- **IndexedDB raw-stream mirror** (roadmap invariant 6's optional cold-start optimization): unaffected by and orthogonal to this design; if added later it mirrors the live window only.
- **Compressing the live file on hibernation**: pause/resume continues to preserve the raw live file; folding it into a segment at pause time is a possible follow-up, not part of this change.

## 10. Implementation plan (suggested PR slicing)

1. **PR-A (server, no protocol change)**: absolute accounting + manifest + segmented cut + crash recovery + lifecycle deletions + `history.startOffset` + `output-truncated` removal. Legacy-compatible by construction (Section 3.3); ships alone safely.
2. **PR-B (protocol)**: `request-history-range` / `history-range` types, route handling, range serving + segment cache, `websocket-protocol.md` update.
3. **PR-C (client)**: store paging state + throwaway replay + shared row pipeline refactor, view trigger + anchoring + eviction, E2E.

## Decisions (owner-approved, 2026-07-03)

The four open questions from the draft were resolved with the owner:

1. **Retention default**: capped — 100 segments per worker (~200MB raw / ~20MB gz at default segment size), configurable; `0` opts into unlimited retention.
2. **Segment size**: reuse the existing 20%-of-max cut (~2MB raw at defaults), coupled to `WORKER_OUTPUT_FILE_MAX_SIZE`. Revisit only if paging granularity feels wrong in practice.
3. **Paged-window cap**: row-based, 15,000 rows (~3x live scrollback). Tune during mobile dogfood if needed.
4. **TUI seam quality**: v1 accepts approximate seams at chunk joins (duplicated prompt fragments possible). No duplicate-row suppression — it risks deleting legitimately repeated lines; reconsider only if dogfood shows the seams are disruptive.

### Revision 2 (codex external review, 2026-07-03)

Dispositions of the 17 external-review findings, all applied above:

1. Fixed the resync direction: a stale-client (`fromOffset > totalAbsoluteOffset`) response necessarily lies **below** the request; unified client predicate compares the response's absolute window against `requestedFromOffset` (Section 3.1).
2. Corrected the false "`pendingFlushes` is effectively single-writer" claim — the threshold and timer paths launch unawaited flushes (`worker-output-file.ts:162`, `:197`), which is why flushes join the lock (Section 4.3).
3. Epoch mismatch now discards the triggering payload, issues a fresh initial `request-history`, and queues live `output` until that history applies, then replays the queue with covered-entry dropping (Section 3.4).
4. On worker restart the server closes all open worker WebSockets with the dedicated `WORKER_RESTARTED` (4001) close code (normal-closure would suppress the client's reconnect) so the reconnect delivers the new epoch; the app-ws `worker-restarted` event is a UX fast-path only (Sections 3.4, 4.5).
5. Epoch is captured atomically with the data/offset it tags, inside the per-worker serialization domain; the output callback widens to `(data, offset, epoch)` (Section 3.4).
6. Epoch changed from a persisted counter to the incarnation creation timestamp in milliseconds — unique without depending on manifest persistence; equality-only comparison tolerates clock regression (Section 3.4).
7. The per-worker lock is one serialization domain covering append/flush, cut, range reads, and reset/delete — not just cut/read (Section 4.3).
8. Manifest `pendingCutBytes` replaced by `pendingCut: { bytes, expectedLiveSizeAfter }`, making step-3 crash recovery decidable (Sections 4.2, 4.3).
9. `fsync` requirements specified — temp file before rename, containing directory after — at the segment- and manifest-write commit points; cost is per-cut, not per-append (Section 4.3).
10. The revised `history` message shape is fully specified (`data`, `offset`, `startOffset`, `epoch`, `timedOut?`) with the initial-vs-incremental client predicate (Section 5.1).
11. New-client/old-server: a bounded 5s timeout with no matching response marks paging unsupported for the connection — silent degrade; also covers server rollback (Section 5.1).
12. `requestId` added to `request-history-range` and echoed in `history-range` and its error path; responses apply only on requestId + epoch + contiguity (`endOffset === oldestOffset`) match (Section 5.1).
13. Client-supplied numeric fields constrained to non-negative safe integers; invalid requests answered with the empty `hasMore: false` shape (Section 5.1).
14. Scroll compensation switched from whole-container `scrollHeight` delta to keyed anchor-row measurement, correct under concurrent bottom append (Section 6.3).
15. Paged chunks are dropped on terminal `cols` resize; retaining raw bytes for re-replay is noted as future work (Section 6.2).
16. Throwaway replay scrollback fixed at 100k rows with an overflow degradation loop re-requesting at `maxBytes/4` down to a 16KB floor (Section 6.2).
17. At the paged cap, upward fetch is refused with an inline notice row; top-chunk eviction (viewport 2+ viewport-heights below) restores headroom and re-enables fetch; no bottom-side eviction (Section 6.4).
