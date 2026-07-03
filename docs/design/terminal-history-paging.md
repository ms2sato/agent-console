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
  - `fromOffset < liveBaseOffset` (client evicted/away long enough that its window scrolled into the archive): do **not** stream the archive forward. Return the initial-load shape (last N lines) with an honest `startOffset > fromOffset`. The client detects `startOffset > requestedFromOffset`, resets its buffer, and treats the payload as a fresh load; older content is reachable via backwards paging. This generalizes and replaces the current `offset < requestedFromOffset` reset heuristic (`poc-terminal-store.ts:499`).
  - `fromOffset > totalAbsoluteOffset` (stale/diverged client): same recent-window response; with absolute offsets this can only happen across a worker restart (offsets reset to 0), which the `worker-restarted` app event already handles client-side (`poc-terminal-store.ts:349-356`).

### 3.2 `output-truncated` disappears

Archival is not data loss and never rebases offsets, so the message has no remaining meaning. Removal plan:

- Delete the emission path: `truncateFile`'s callback invocation (`worker-output-file.ts:296-298`), `OutputTruncatedCallback` / `setOutputTruncatedCallback` (`worker-output-file.ts:18-30`), `notifyWorkerOutputTruncated` and its registration (`routes.ts:202-225`, `:296-298`, and the `REQUIRED_INIT_STEPS` entry at `:233`).
- Delete the type from `WorkerServerMessage` (`session.ts:157`) and from `WORKER_SERVER_MESSAGE_TYPES` (`session.ts:133`). **Do not reuse ordinal 6** for a future message.
- Delete the client handler (`poc-terminal-store.ts:481-485`). A stale browser tab running a pre-upgrade bundle keeps a dead handler for a message the server never sends — harmless.
- Update `websocket-protocol.md` and the roadmap's feature-inventory row for `output-truncated`.

### 3.3 Upgrade compatibility (pre-upgrade client offset vs post-upgrade server)

The client's `lastOffset` lives only in module memory (`poc-terminal-store.ts:113`); there is no persisted offset store. The upgrade scenario is therefore: a browser tab stays open across a server upgrade, reconnects, and sends `request-history { fromOffset: <pre-upgrade value> }` (`poc-terminal-store.ts:409-414`).

At upgrade time the manifest does not exist yet, so `liveBaseOffset` initializes to 0 and the absolute offset equals today's file-relative `totalOffset` — the old value is directly compatible. The one divergent case: the pre-upgrade server had truncated during the old incarnation, so the tab's `lastOffset` (fed by never-rebased `output` offsets) exceeds the file size. The `fromOffset > totalAbsoluteOffset` valve (Section 3.1) returns the recent window; the client resets. This is the same resync dance that handles this case today — no migration code is required, only a migration **test** (Section 8).

## 4. Segmented archive

### 4.1 Cut operation

`flushBuffer`'s size check (`worker-output-file.ts:249-252`) keeps its trigger (live file > `fileMaxSize`) but the action changes from destroy-oldest-20% to archive-oldest-20%:

1. Compute the slice point exactly as today: `currentSize - floor(fileMaxSize * 0.8)`, advanced to a UTF-8 character boundary by skipping continuation bytes (`worker-output-file.ts:280-287`). At defaults this yields ~2MB uncompressed per segment.
2. Gzip the head slice and write it to `outputs/<sessionId>/<workerId>.seg-<N>.log.gz` (write `*.tmp`, then `rename`). `N` is a monotonically increasing sequence number from the manifest; it never resets or backfills, so pruning leaves gaps in `N` but order stays total. Note: the write-side gzip helper must be (re)introduced — current code imports only `gunzipSync` (`worker-output-file.ts:7`); the hibernation-era `.log.gz` support is read-only legacy compatibility (`worker-output-file.ts:103-121`).
3. Rewrite the live file to the remainder (write `<workerId>.log.tmp`, then `rename` — the current in-place `writeFile` at `worker-output-file.ts:291` is not crash-safe and is replaced).
4. No client notification (Section 3.2).

### 4.2 Manifest (sidecar JSON)

Per worker: `outputs/<sessionId>/<workerId>.segments.json`.

```json
{
  "version": 1,
  "liveBaseOffset": 4194304,
  "pendingCutBytes": 0,
  "segments": [
    { "seq": 0, "startOffset": 0,       "endOffset": 2097152, "bytes": 2097152, "gzBytes": 183214, "file": "w-abc.seg-0.log.gz" },
    { "seq": 1, "startOffset": 2097152, "endOffset": 4194304, "bytes": 2097152, "gzBytes": 190022, "file": "w-abc.seg-1.log.gz" }
  ]
}
```

**Why a sidecar rather than naming-convention-only:** absolute-range mapping needs each segment's *uncompressed* start/end without opening it (gzip's ISIZE footer is mod 2^32 and costs a read per file); `liveBaseOffset` must survive even when all segments are pruned; and the manifest is the anchor for crash recovery. The manifest is always written temp-then-rename. If it is missing or unparsable, the worker degrades to today's semantics (`liveBaseOffset = 0`, no paging past the live file) — never a hard failure.

Absolute-range mapping: a segment covers `[startOffset, endOffset)`; the live file covers `[liveBaseOffset, liveBaseOffset + fileSize)`; the pending buffer follows. `firstAvailableOffset = segments[0]?.startOffset ?? liveBaseOffset` (rises above 0 once retention prunes).

### 4.3 Crash safety (two-phase cut)

Ordering, with recovery meaning for a crash after each step:

1. Write + rename `seg-N.log.gz`. *(Crash here: orphan segment file not referenced by the manifest; its data is still fully present in the live file. Recovery: delete orphans whose `seq` is not in the manifest.)*
2. Write + rename the manifest with the new segment appended, `liveBaseOffset` advanced to the new segment's `endOffset`, and `pendingCutBytes = <cut length>`. *(Crash here: the manifest claims the cut but the live file still contains the duplicated head. Recovery: `pendingCutBytes > 0` → redo step 3.)*
3. Rewrite the live file without the head (temp + rename). *(Idempotence guard for redo: only re-cut if the live file's size is `pendingCutBytes` larger than expected; sizes match after a completed step 3.)*
4. Write + rename the manifest with `pendingCutBytes = 0`.

Recovery runs lazily on first access to a worker's output (manifest load), before any read is served. Cuts and range reads for the same worker are serialized on a per-worker promise-chain lock (the manager is already effectively single-writer per worker via `pendingFlushes`; the lock extends that to the cut/read pair) so no read ever observes the intermediate state between steps 2 and 3.

### 4.4 Retention

- **Default: keep all segments.** ANSI-heavy streams compress at roughly 10:1 (the 34%/66% measurement in #959); a 100MB-raw session archives to ~10MB on disk.
- Optional cap: `WORKER_OUTPUT_MAX_SEGMENTS` (new `server-config.ts` entry, default `0` = unlimited). When exceeded after a cut, delete the oldest segment files and drop their manifest entries (manifest rewrite is the commit point; a crash between file-delete and manifest-rewrite leaves a missing file whose range is served as unavailable — the range response degrades to `hasMore: false`).
- No retention UI in this issue (Section 9).

### 4.5 Lifecycle interactions

- **Session deletion**: `deleteSessionOutputs` removes the whole `outputs/<sessionId>` directory (`worker-output-file.ts:669-673`); segments and manifest live there — covered with no change. Quick sessions share the same resolver layout (`session-data-path-resolver.ts:28-30`) — covered.
- **Worker deletion**: `deleteWorkerOutput` currently deletes only `.log` and legacy `.log.gz` (`worker-output-file.ts:624-644`); extend it to delete `seg-*.log.gz` and the manifest.
- **Worker restart**: `restartWorker` calls `resetWorkerOutput` (`worker-lifecycle-manager.ts:408`) and re-creates the worker with `outputOffset: 0` (revived: false, `:436-438`). `resetWorkerOutput` (`worker-output-file.ts:570-607`) must also delete all segments and the manifest so the absolute stream genuinely restarts at 0. Client-side, the `worker-restarted` app event already resets the terminal and `lastOffset` (`poc-terminal-store.ts:349-356`); it must additionally clear the paged-in window (Section 6).
- **Hibernation / pause-resume**: pausing kills PTYs but preserves output files (`session-pause-resume-service.ts:105-113`); segments and manifest are equally preserved. Legacy hibernation-era `<workerId>.log.gz` files keep their existing read/migration path (`worker-output-file.ts:103-121`, `:220-243`); when one is migrated to `.log` on first write, its content is the start of the stream, so `liveBaseOffset = 0` remains correct. Range paging works on a hibernated session because the worker WebSocket restores the worker on connect (`routes.ts:754`) and range serving needs only file access.

## 5. Protocol addition: `request-history-range`

### 5.1 Messages

Client → Server (`WorkerClientMessage`, `session.ts:118-121`):

| Type | Payload | Description |
|------|---------|-------------|
| `request-history-range` | `{ beforeOffset: number, maxBytes?: number }` | Request history bytes strictly before absolute offset `beforeOffset`. `maxBytes` is a hint; the server applies its own cap. |

Server → Client (`WorkerServerMessage`, `session.ts:151-158`; add `'history-range': 8` to `WORKER_SERVER_MESSAGE_TYPES`):

| Type | Payload | Description |
|------|---------|-------------|
| `history-range` | `{ data: string, startOffset: number, endOffset: number, hasMore: boolean }` | `data` covers absolute `[startOffset, endOffset)` with `endOffset <= beforeOffset`. `hasMore` is `startOffset > firstAvailableOffset`. An unavailable range (pruned, or `beforeOffset <= firstAvailableOffset`) returns `data: ''`, `startOffset = endOffset = beforeOffset`, `hasMore: false`. |

Handled in the worker WS `onMessage` next to the existing `request-history` branch (`routes.ts:804-907`), with the same 5s timeout guard and an equivalent error path (`HISTORY_LOAD_FAILED`).

### 5.2 Serving rules

- **One storage unit per response — the server clamps to a single segment (or the live file) and never stitches across a boundary.** Justification: (a) each response costs at most one gunzip of one ~2MB segment; (b) the mapping code is a lookup, not a multi-file scatter-gather; (c) the client's loop is already incremental — a short response simply triggers the next `request-history-range` with `beforeOffset = startOffset`, so boundary clamping costs one extra round trip at worst, invisible behind scroll physics. The client must treat `startOffset`/`endOffset` as authoritative and never assume `endOffset - startOffset == maxBytes`.
- Within the unit, serve the trailing `min(maxBytes, SERVER_RANGE_CAP)` bytes ending at `min(beforeOffset, unitEnd)`. `SERVER_RANGE_CAP` = 256KB (new config, `WORKER_OUTPUT_RANGE_MAX_BYTES`).
- **Boundary hygiene**: `startOffset` is always advanced to a UTF-8 character boundary (same continuation-byte skip as `worker-output-file.ts:285-287`). Best-effort newline alignment: advance `startOffset` to the byte after the first `\n` within the first 4KB of the slice, if one exists — this makes chunk seams start at a line head, which materially improves the client's replay quality for line-flow content. (Segment *cut* points from Section 4.1 are UTF-8-aligned only; the read side does the newline cosmetics.)
- **Decompression cost**: use async `node:zlib` `gunzip` (promisified), not `gunzipSync`, per the backend async-over-sync rule — a 2MB segment is single-digit-ms work but there is no reason to block the event loop. Because a 2MB segment serves ~8 consecutive 256KB pages, keep a **per-worker, single-entry decompressed-segment cache** (seq + Buffer, invalidated on prune/reset/delete); a paging burst then costs one gunzip per segment, not per page. Memory bound: one uncompressed segment (~2MB) per actively-paging worker, dropped with the entry on a short TTL (30s).

## 6. Client design (next renderer)

### 6.1 Trigger and fetch loop

`PocTerminalView`'s native scroll container (`PocTerminalView.tsx:484-499`) gains a top-edge check in the existing `onScroll` handler: when `scrollTop < ~2 viewport-heights`, `bufferType === 'normal'` (alt-screen scroll is forwarded to the app, `PocTerminalView.tsx:278`), no range request is in flight, and `oldestOffset > 0` with `hasMore` not exhausted → call a new store method `requestOlderHistory()`.

Store state added:

- `oldestOffset`: absolute start of everything currently represented (seeded by the new `history.startOffset` on initial load, moved down by each `history-range.startOffset`).
- `pagedChunks: PocRow[][]` (deque, oldest first) + `pagedRowCount`, `hasMoreHistory: boolean`, `loadingOlder: boolean` (surfaced in the snapshot alongside `loadingHistory`, `poc-terminal-store.ts:43`).

Requests chain contiguously: `request-history-range { beforeOffset: oldestOffset, maxBytes: 262144 }`; the response's `startOffset` becomes the next `beforeOffset`. Contiguity with the live window is structural — the first request starts exactly at the initial window's `startOffset`.

### 6.2 Throwaway headless VT replay

ANSI streams cannot be replayed from an arbitrary midpoint (order-dependent cursor/screen state), so each fetched chunk is rendered by a **throwaway** `@xterm/headless` `Terminal` created per chunk and disposed immediately:

- Construct with the live terminal's current `cols` (wrap parity with the visible window), a small `rows` (e.g. 24), and `scrollback` sized for the chunk (256KB of line-flow output at 80 cols is < 4k rows; use the chunk-size-derived bound).
- Write `processOutput(data)` — the same `stripSystemMessages` / `stripScrollbackClear` filter pipeline the live store applies (`poc-terminal-store.ts:277-280`), so paged rows match live rows in content policy. Known limitation: filters straddling a *range* boundary can leak fragments, the same pre-existing chunk-boundary gap the roadmap documents for `output` messages; newline alignment (Section 5.2) reduces exposure.
- After the write callback, extract rows via the same `extractRow` path used by `rebuildSnapshot` (`poc-terminal-store.ts:600-606`): keep all scrollback rows (`y < baseY`) **plus the settled prefix of the final screen — rows up to and including the cursor row, with trailing blank rows trimmed**. Rows below the cursor are the volatile screen region and are discarded. For line-flow output this keeps exactly the chunk's tail; for TUI redraw churn the result is approximate by design (acknowledged in #959 — the archive pages through what was drawn; "what was said" belongs to #958's reader view).
- Dispose the throwaway terminal.

### 6.3 Prepend, keys, row cache, and anchoring

- The live `rowCache` (`poc-terminal-store.ts:126-129`) and `rebuildSnapshot` remain untouched: paged rows never enter the live buffer or its cache. The snapshot's `rows` becomes `[...pagedChunks.flat(), ...liveRows]`.
- **Keys**: live rows use the buffer index `y >= 0`; paged rows use negative keys allocated downward (newest paged chunk gets `-1 .. -n`, the next older chunk continues below), stable for the chunk's lifetime. React list identity and `React.memo` reuse then work unchanged. Cursor rendering is unaffected — the cursor is baked into the live row via `extractRowWithCursor` (`poc-terminal-store.ts:604`), not positioned by array index.
- **Scroll anchoring**: on prepend (and on eviction), the view measures `scrollHeight` before/after the row-array change in a layout effect and adjusts `scrollTop` by the delta. Explicit compensation is chosen over CSS `overflow-anchor` because concurrent live appends at the bottom mutate `scrollHeight` in the same frame and the store cannot rely on browser anchoring heuristics across both edges.
- **Links and #958 decorators**: `detectRowLinks` runs over each replayed chunk with the same wrapped-line-window logic as `rebuildSnapshot` (`poc-terminal-store.ts:619-631`). The row extraction + link detection + (future) #958 tier-1 classification/restyle steps are factored into one shared **row pipeline** function used by both `rebuildSnapshot` and the chunk replay, so decorators apply to paged-in rows by construction rather than by parallel implementation. This refactor is a prerequisite noted for the #958 implementation.

### 6.4 Paged-window memory cap and eviction

The paged window is droppable and re-fetchable (server keeps everything), so the cap can be aggressive:

- Cap: `MAX_PAGED_ROWS` ≈ 15,000 rows (≈ 3× the live `SCROLLBACK` of 5,000, `poc-terminal-store.ts:67`) or `MAX_PAGED_CHUNKS` — whichever form, a single constant beside the store's other timings.
- Eviction (v1, simple): when over cap after a prepend, drop the **oldest (topmost) chunk** only if the viewport currently sits more than ~2 chunk-heights below it; raise `oldestOffset`... no — eviction from the top means the *top* of the window is gone, so `oldestOffset` moves **up** to the evicted boundary and `hasMoreHistory` returns to `true`; scrolling up again re-fetches. Apply the same scrollTop compensation as prepend.
- Full teardown of paged state on: `worker-restarted` (`poc-terminal-store.ts:349-356`), terminal reset in the `startOffset > requestedFromOffset` resync path, and instance disposal (idle TTL / LRU eviction, `poc-terminal-store.ts:336-343`, `:680-693` — paged rows die with the instance, by design).

## 7. Edge cases

- **Fetch during active output**: paging touches the top edge, live output the bottom; absolute offsets make them independent. A cut can migrate bytes from the live file into a new segment between two page requests — the per-worker lock (Section 4.3) serializes cut vs. read, and the manifest lookup happens inside the lock, so a request is served from wherever the range lives at that moment. The client's anchoring measures DOM deltas, so simultaneous append + prepend in one frame stays stable.
- **Worker restart / output reset**: covered in Section 4.5; the invariant is that `resetWorkerOutput` and restart drop *all* storage (live + segments + manifest) and both offset series restart at 0 together.
- **Multi-client concurrent paging**: range serving is stateless per request (all paging cursor state lives in each client's store); the only shared server object is the single-entry decompressed-segment cache, which is read-only shared and safe. N clients paging different segments of the same worker degrade the cache to per-request gunzip — acceptable.
- **Quick sessions**: identical storage layout and deletion path (Section 4.5); no special handling.
- **Hibernated sessions**: paging works after the connect-time restore (Section 4.5); revived offset seeding stays absolute via the updated `getCurrentOffset` (Section 3.1).
- **Range request while a legacy `<workerId>.log.gz` (hibernation-era) is still un-migrated**: the manager already decompresses it for reads (`worker-output-file.ts:347-350`); it is the whole stream at base 0, so range mapping treats it as the live file. No segments can exist alongside it (segments are only created by the new write path, which migrates first, `worker-output-file.ts:220-243`).

## 8. Testing plan

**Unit — server accounting and segmentation** (extend `packages/server/src/lib/__tests__/worker-output-file.test.ts`, config-injected small sizes via `WorkerOutputFileConfig`, `worker-output-file.ts:55-59`):
- Cut produces a segment + manifest with correct absolute ranges; UTF-8 boundary respected for multi-byte content spanning the cut point.
- `history.offset` / `history.startOffset` / `getCurrentOffset` are absolute across multiple cuts; `output` offsets (via a simulated `worker.outputOffset`) match `history` offsets after cuts.
- Crash recovery: manifest with `pendingCutBytes > 0` + oversized live file → redo; orphan segment file → cleanup; completed state → no-op (idempotence).
- Range serving: within live file; within a gz segment (round-trips through real gzip); clamped at segment↔live and segment↔segment boundaries; `maxBytes` and server cap; newline alignment; pruned/unavailable range → empty + `hasMore: false`; `hasMore` correctness at `firstAvailableOffset`.
- `resetWorkerOutput` / `deleteWorkerOutput` remove segments + manifest; `deleteSessionOutputs` leaves nothing.
- Legacy `.log.gz` migration still passes existing tests, and a range request against an un-migrated legacy file serves at base 0.

**Unit — client store** (extend `packages/client/src/labs/terminal-poc/__tests__/`, mock WS as existing store tests do):
- `requestOlderHistory` chains `beforeOffset` from response `startOffset`; in-flight guard; `hasMore` stop condition.
- Replay extraction: line-flow fixture (rows exactly match expected text, trailing blanks trimmed), TUI-churn fixture (no crash, volatile region discarded), wrapped-URL chunk (link detection parity with live pipeline).
- Prepend keys stable and unique vs. live keys; decorator/row-pipeline applied to paged rows (shared-pipeline test).
- Eviction: cap enforced, `oldestOffset` restored to evicted boundary, re-fetch works.
- `worker-restarted` and resync-reset clear paged state.

**Integration (wire)** (server WS route tests alongside existing `routes` tests): `request-history-range` over a real upgrade path; range fetch racing live `output` (assert offset coherence); two connections paging the same worker; hibernated worker restore + immediate range request; timeout path returns the error shape.

**E2E** (`e2e/`): generate a multi-MB session (looped line output past several cut points), reload the page, deep-scroll to the earliest content: assert (a) earliest line reachable, (b) scroll position stable across each prepend (no jump), (c) no duplicated/garbled seam lines for line-flow content, (d) memory: paged window capped (indirectly via row count).

**Migration test**: simulate the pre-upgrade divergence — build a live file, apply the *old* truncation semantics to it (head-trimmed file, client `lastOffset` larger than file size, no manifest) — then run the new server against it: `request-history fromOffset=<stale>` must return the recent window with `startOffset > fromOffset`, and the store must reset and continue (no loop, no crash).

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
