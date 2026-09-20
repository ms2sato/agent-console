#!/usr/bin/env bash
#
# Pure, side-effect-free check functions shared by
# scripts/setup-multiuser-for-ubuntu.sh and its tests (Issue #1222).
#
# Split out of the main script so the fail-closed provisioning guard can be
# unit-tested directly (sourced by scripts/__tests__/setup-multiuser-checks.test.mjs)
# without requiring root or the rest of the script's argument parsing / step
# execution. Functions here must not read globals from the caller and must
# not have side effects beyond inspecting the filesystem and printing to
# stderr -- they are library functions, not steps.

# assert_unified_bun_executable <path>
#
# Fails closed (Issue #1222 Ruling 2): if <path> does not exist or is not
# executable, prints a diagnostic naming the path and the remedy to stderr
# and returns 1. Returns 0 when <path> is executable. Callers are
# responsible for deciding WHEN to invoke this (setup-multiuser-for-ubuntu.sh
# only calls it for a real, non-dry-run unit install -- a --dry-run preview
# on a fresh host, before Step 6b has actually copied the binary, must not
# fail here).
assert_unified_bun_executable() {
  local bun_path="$1"
  if [ ! -x "$bun_path" ]; then
    echo "error: unified bun binary '$bun_path' is missing or not executable -- refusing to install a systemd unit whose ExecStart cannot start (Issue #1222). Ensure Step 6b (embedded-agent bun binary copy) completed, or copy it manually: sudo install -m 0755 <service-user-bun> $bun_path" >&2
    return 1
  fi
  return 0
}

# assert_readable_file <path> <hint>
#
# Fails closed (Issue #1668): if <path> does not exist or is not readable,
# prints a diagnostic naming the path and <hint> (the remedy text) to stderr
# and returns 1. Returns 0 when <path> is readable. More general than
# assert_unified_bun_executable above -- it does not require the executable
# bit, because the embedded-agent entry file is `bun <entry>`'s script
# ARGUMENT, not a binary to be executed directly -- but the same fail-closed
# shape and caller-decides-when discipline: update-and-deploy-for-multiuser-
# ubuntu.sh calls this only for a real deploy, right before `systemctl
# restart`, after its own copy step has unconditionally run.
assert_readable_file() {
  local file_path="$1"
  local hint="$2"
  if [ ! -r "$file_path" ]; then
    echo "error: '$file_path' is missing or not readable -- $hint" >&2
    return 1
  fi
  return 0
}

# readability_probe_marker <path> [elevate]
#
# The probe half of assert_readable_by_unprivileged_user below, split out so
# the post-deploy verification's V2 (entry_path_readable, further down) can
# read the same three-way answer without duplicating the chain. Prints
# exactly one of these on stdout and always returns 0:
#   NO_RUNUSER   -- `runuser` (util-linux) is not on PATH; nothing was probed
#   READABLE     -- the chain ran and `test -r` was true for `nobody`
#   UNREADABLE   -- the chain ran and `test -r` was false for `nobody`
#   <anything else, typically empty> -- the chain did not complete (elevation
#                   refused, `runuser` itself failed); its stderr is passed
#                   through to this function's stderr for the caller to attach
# The caller decides what each answer MEANS (a fail-closed gate, a
# PASS/FAIL/SKIP screen line); this function only reports it.
readability_probe_marker() {
  local file_path="$1"
  local elevate="${2:-}"
  if ! command -v runuser >/dev/null; then
    echo NO_RUNUSER
    return 0
  fi
  # shellcheck disable=SC2086 # $elevate is a single deliberate command-name
  # word (empty, or the caller's own bare elevation form) -- word-splitting
  # is how an empty value disappears entirely rather than becoming a
  # spurious empty argument.
  ${elevate} runuser -u nobody -- sh -c 'test -r "$1" && echo READABLE || echo UNREADABLE' _ "$file_path" || true
  return 0
}

# assert_readable_by_unprivileged_user <path> <hint> [elevate]
#
# Fails closed (Issue #1668, Architect ruling): unlike assert_readable_file
# above, this probes readability from an UNPRIVILEGED user's view via
# `<elevate> runuser -u nobody -- sh -c 'test -r "$1" && echo READABLE ||
# echo UNREADABLE' _ <path>` (Issue #1690: the marker-based form below, not
# a bare `runuser -u nobody -- test -r <path>` whose exit code is checked
# directly), not the invoking process's own permission. This matters because
# a root-side check bypasses DAC read
# checks (CAP_DAC_READ_SEARCH), including parent-directory traversal -- a
# plain `[ -r <path> ]` as root is true for ANY existing file regardless of
# actual permission bits, so assert_readable_file's own check can never
# fail for the exact defect Issue #1668 is about (a path unreachable to a
# non-root elevation-target user, even though root itself can always read
# it).
#
# `nobody` is guaranteed outside this project's shared group, so it
# represents the elevation target's (worst-case) view. `runuser` is
# root-only, so the probe itself needs root -- but the CALLER
# (update-and-deploy-for-multiuser-ubuntu.sh) runs as the operator's own
# login user, not as root: every privileged step elevates itself
# individually, and this probe is no exception. [elevate] (default: empty)
# is the elevation prefix the caller prepends to reach root for this one
# call -- empty when the caller is already root (`id -u` = 0), the caller's
# ordinary bare, interactive-capable elevation form otherwise. It is an
# explicit parameter, never read from the environment, so the mechanism can
# be faked at this exact seam in a unit test (see below) without needing
# real root or a real `runuser` (Issue #1690; #1673's "cannot be faked in a
# unit test" claim was true only because that PR probed via bare `runuser`
# with no seam to fake).
#
# Readability is decided from the probe's STDOUT, never from its exit code
# (Issue #1690): `test -r` returning false and the elevation step itself
# being refused both exit non-zero, and #1673's original
# `if ! runuser ...; then "not readable" fi` shape could not tell those
# apart -- an operator with no elevation to `runuser` got a "not readable"
# diagnostic that had nothing to do with file permissions. The inner `sh -c`
# instead prints an explicit marker (READABLE / UNREADABLE) that only a
# successfully-completed test can produce; anything else on stdout (empty,
# because elevation or `runuser` itself failed before the marker could be
# printed; or garbage) is reported as "probe could not run", a distinct
# cause, with the captured stderr attached.
assert_readable_by_unprivileged_user() {
  local file_path="$1"
  local hint="$2"
  local elevate="${3:-}"

  local stderr_tmp
  stderr_tmp="$(mktemp)"
  local marker
  marker="$(readability_probe_marker "$file_path" "$elevate" 2>"$stderr_tmp")"
  local captured_stderr
  captured_stderr="$(cat "$stderr_tmp")"
  rm -f "$stderr_tmp"

  case "$marker" in
    NO_RUNUSER)
      # Guard BEFORE the probe (Architect ruling): without this, a missing
      # `runuser` binary makes the probe itself exit 127, which the
      # fail-closed branch below would misreport as "not readable by an
      # unprivileged user" -- true-sounding, but naming the wrong cause. The
      # gate stays closed either way; only the diagnostic changes.
      echo "error: runuser (util-linux) not found -- required for the unprivileged readability gate" >&2
      return 1
      ;;
    READABLE)
      return 0
      ;;
    UNREADABLE)
      echo "error: '$file_path' is not readable by an unprivileged user (probed as 'nobody' via runuser -- any real elevation-target user hits the same wall) -- $hint" >&2
      return 1
      ;;
    *)
      echo "error: readability probe for '$file_path' could not run -- elevation or runuser itself failed before the readability check could complete (${captured_stderr:-no diagnostic output captured})" >&2
      return 1
      ;;
  esac
}

# dist_artifact_present <dist_index_path>
#
# Issue #1707: reports whether the built artifact Step 8 needs before it may
# safely `enable --now` the systemd unit already exists. The unit's
# ExecStart runs `bun run start` -> `bun dist/index.js`; enabling with
# `--now` before that file has ever been built manufactures a crash loop
# under Restart=on-failure (NRestarts climbing every 5s, Result=exit-code --
# measured in docs/design/elevation-verification-tiers.md Task 0 S2, both
# runs). Existing provisioned hosts are unaffected: the file already exists
# there (a prior deploy created it), so `--now` still runs exactly as today.
#
# Returns 0 when the artifact exists (Step 8 may pass --now) or 1 when it
# does not (Step 8 must `enable` alone). This is a decision predicate, not a
# fail-closed guard like assert_unified_bun_executable above -- a return of 1
# is the ordinary, recoverable state of a fresh host before the first
# deploy, not an error, and callers must not treat it as one (no `err` /
# script-abort on this branch). When absent, prints the build-first remedy
# message to stderr exactly once here, so callers never need their own copy
# of the message text.
dist_artifact_present() {
  local dist_index_path="$1"
  if [ -f "$dist_index_path" ]; then
    return 0
  fi
  echo "built artifact absent -- run scripts/update-and-deploy-for-multiuser-ubuntu.sh once to build and start the unit" >&2
  return 1
}

# resolve_health_port <live-port-or-empty> <override-or-empty> <default>   (Issue #1761)
#
# V5's port input used to be a single guessed default (AGENT_CONSOLE_PORT,
# falling back to 8080) with no connection to what the live unit actually
# binds -- the unit is the single writer of the port the server binds (its
# `Environment=PORT=` line, rendered by scripts/setup-multiuser-for-
# ubuntu.sh), so a guessed default could silently disagree with a host whose
# PORT= differs from it. This resolves the port to probe by PRECEDENCE (the
# live unit wins, then an explicit override, then the compiled-in default)
# and reports which source it used.
#
# <live-port-or-empty> is V1's own PORT= read from the live unit's effective
# Environment (unit_env_drift's VERIFY_LAST_STDOUT -- the same single read
# CONFIGURED_BUN already uses for EMBEDDED_AGENT_BUN_PATH, no second
# `systemctl show` call). <override-or-empty> is AGENT_CONSOLE_PORT, kept
# only as a fallback for a unit whose template does not (yet) declare
# `PORT=`. <default> is the script's own compiled-in fallback (8080).
#
# Prints `PORT_SOURCE:<unit|override|default>` on stdout line 1 and the
# resolved port on stdout line 2. When both the live unit's port and the
# override are non-empty and differ, warns on stderr naming both (the unit
# still wins) -- an operator-set AGENT_CONSOLE_PORT that no longer matches a
# re-rendered unit is exactly the drift this function exists to surface
# rather than silently overriding. Always returns 0: a resolution decision
# is never itself a deploy failure -- the caller's own V5 health probe is
# what can still fail, against whichever port this resolved.
resolve_health_port() {
  local live="$1"
  local override="$2"
  local default="$3"

  if [ -n "$live" ]; then
    if [ -n "$override" ] && [ "$override" != "$live" ]; then
      echo "WARN: AGENT_CONSOLE_PORT=${override} differs from the live unit's PORT=${live}; using the unit's" >&2
    fi
    echo "PORT_SOURCE:unit"
    echo "$live"
    return 0
  fi

  if [ -n "$override" ]; then
    echo "PORT_SOURCE:override"
    echo "$override"
    return 0
  fi

  echo "PORT_SOURCE:default"
  echo "$default"
  return 0
}

# ---------------------------------------------------------------------------
# Post-deploy verification checks V0-V6 (Issue #1717, absorbing #1688;
# V0 added by Issue #1754).
#
# scripts/update-and-deploy-for-multiuser-ubuntu.sh runs these in order --
# V0 and V1 BEFORE `systemctl restart` (fail-closed), V2-V6 after it -- and
# prints one PASS / FAIL / SKIP line per check. Spec: the "Post-deploy
# verification -- checks enumerated" table in
# docs/design/elevation-verification-tiers.md.
#
# Shared contract (the three-way marker convention of
# assert_readable_by_unprivileged_user, generalised):
#   return 0  PASS        -- the check ran and the system is right
#   return 1  FAIL        -- the check ran and the system is wrong
#   return 2  cannot run  -- a mechanism failure (systemctl / journalctl /
#                            curl / elevation / runuser absent or refused);
#                            never reported as a system failure
#   stdout    line 1 is a machine-readable marker (named per check below);
#             further lines are per-check detail the caller may parse
#   stderr    the human reason (first line = summary) on FAIL / cannot-run;
#             on PASS, optional `WARN: ...` / `INFO: ...` annotation lines
# Every external command a check needs is an explicit argument (the
# `<systemctl-cmd>` / `<journalctl-cmd>` / `<curl-cmd>` / `<elevate>`
# parameters), never read from the environment and never a literal here, so
# each check is pure over its inputs and can be driven by the fake scripts
# under scripts/__tests__/fixtures/ -- the #1690 seam, applied to every
# check that shells out. The elevation prefix is word-split unquoted exactly
# as assert_readable_by_unprivileged_user does, for the same reason (an
# empty value must vanish, not become an empty command name).
# ---------------------------------------------------------------------------

# data_root_ownership <data-root> <service-user> <find-cmd>   (V0, Issue #1754)
#
# Mechanizes the setup guide's "Data-root ownership pre-deploy check": walks
# the same two trees the trusted-root walker (ensureTrustedDirChain,
# packages/server/src/lib/trusted-dir.ts) creates through, and fails when any
# directory AT A WALKED POSITION is not owned by the service user. Read-only
# classification -- it never chowns anything (Issue non-goal); the operator
# decides.
#
# Prunes, rather than filters, everything BELOW `worktrees/`: a `wt-NNN-XXXX`
# directory is user-owned and may be `0700`, and a find that DESCENDS into it
# prints permission errors on stderr and exits non-zero even though nothing
# wrong was found at a walked position (measured on the dogfood host,
# Issue #1754). `-prune` keeps find out of it entirely; `worktrees` itself is
# still tested and printed when mis-owned, since `*/worktrees/*` needs a path
# segment AFTER `worktrees` to match.
#
# A start point that does not exist yet (a fresh install, no `_quick`) is not
# an error -- each is tested with `[ -d ]` and only the existing ones are
# passed to find. Zero existing start points is OWNERSHIP_NO_TREES, not a
# failure -- but only once <data-root> itself is confirmed to be an
# accessible directory; an untraversable root is cannot-run, not
# OWNERSHIP_NO_TREES (see the guard at the top of the function).
#
# Classification is by position on the path relative to <data-root> (prefix
# stripped, no realpath -- a symlink at a walked position is the walker's
# job, not this check's) and, where position alone is ambiguous, by NAME:
# the walked child names below and the UUID v4 shape of session / worker
# ids. classify_walked (below) is the single writer of the rules; the
# guide's "Data-root ownership pre-deploy check" section mirrors them in
# prose for a human to read -- keep the two in sync.
#
# Markers (stdout line 1): OWNERSHIP_OK (rc 0) | OWNERSHIP_NO_TREES (rc 0) |
# OWNERSHIP_MISOWNED:<n> (rc 1). Lines 2+ are the offending absolute paths,
# one per line, in the order find printed them. A find failure that printed
# no offending walked path is cannot-run (rc 2); a find failure that DID
# print one is still a FAIL (rc 1) -- the worst code, per the shared contract
# above.

# WALKED_CHILD_NAMES: the child directory names the trusted-root walker
# (ensureTrustedDirChain) creates directly under a repo base (one- or
# two-segment) or under _quick. classify_walked below is the single writer
# of the full rules; this array is the one list every rule below reads.
WALKED_CHILD_NAMES=(outputs memos messages memory worktrees)

# _is_walked_child_name <name>: true iff <name> is one of WALKED_CHILD_NAMES.
_is_walked_child_name() {
  local name="$1" w
  for w in "${WALKED_CHILD_NAMES[@]}"; do
    [ "$name" = "$w" ] && return 0
  done
  return 1
}

# _has_walked_child <root> <base-rel>: true iff <root>/<base-rel> has a
# direct child directory named after one of WALKED_CHILD_NAMES -- i.e.
# <base-rel> has actually been used as a repo base at least once. Traversal
# only (2775 directories), never ownership -- this never chowns anything,
# same read-only contract as data_root_ownership itself.
#
# A base that exists but has no such child yet (never used) is classified
# as not-yet-a-base by this probe -- a known, accepted limit: the walker
# creates the children as the service user on first use, and would itself
# fail closed on an unowned empty base with its own diagnostic (the
# "Trusted directory segment has unexpected owner" message).
_has_walked_child() {
  local root="$1" base_rel="$2" w
  for w in "${WALKED_CHILD_NAMES[@]}"; do
    [ -d "${root}/${base_rel}/${w}" ] && return 0
  done
  return 1
}

# _org_dir_has_walked_grandchild <root> <org-rel>: true iff <root>/<org-rel>
# has at least one existing child directory that itself has a direct walked
# child -- i.e. <org-rel> is the ORG segment of a two-segment slug with at
# least one already-used repo underneath it.
_org_dir_has_walked_grandchild() {
  local root="$1" org_rel="$2" child repo
  for child in "${root}/${org_rel}"/*/; do
    [ -d "$child" ] || continue
    repo="${child%/}"
    repo="${repo##*/}"
    _has_walked_child "$root" "${org_rel}/${repo}" && return 0
  done
  return 1
}

# UUID v4 as printed by crypto.randomUUID() (session ids: session-manager.ts;
# worker ids: worker-lifecycle-manager.ts): 8-4-4-4-12 lowercase hex, version
# nibble fixed to 4, variant nibble restricted to 8-b.
UUID_V4_RE='^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

# _classify_below_walked_base <root> <base-rel> <seg1> [<seg2> [<seg3>]]
#
# Applies the below-base rules to the path segments AFTER a resolved walked
# base (either "_quick", or a one-/two-segment "repositories/..." base --
# the caller has already decided which). <root> is unused by every branch
# except the identically-shaped ones that could need it in the future; kept
# as the first parameter for symmetry with the other _* helpers.
#   <name>                walked iff <name> is a WALKED_CHILD_NAMES entry
#   outputs/<x>            walked iff <x> is a UUID v4 (session id)
#   messages/<x>           walked iff <x> is a UUID v4 (session id)
#   messages/<x>/<y>       walked iff BOTH <x> and <y> are UUID v4 (session
#                          id / worker id)
#   memory/<x>              walked for ANY single <x> -- an accepted
#                          over-inclusion: builtin definition ids are not
#                          UUIDs ('claude-sdk-builtin', claude-sdk-
#                          builtin.ts) and quick cwd slugs are
#                          <basename>-<12 hex> (computeQuickCwdSlug,
#                          session-data-path.ts), so a precise id check
#                          isn't possible here; this costs at most one
#                          harmless chown, never a missed one
#   _quick/memory/<x>/<y>   walked for ANY <x>, <y> -- the F5 getMemoryDir
#                          asymmetry: repositories/.../memory/<x>/<y> is
#                          deliberately NOT walked (only the _quick form
#                          is), pinned by the (d) test in the sibling
#                          test file
# Anything else below a base (an operator's ad-hoc directory) is ignored.
_classify_below_walked_base() {
  local root="$1" base_rel="$2"
  shift 2
  local name0="$1" name1="${2:-}" name2="${3:-}"

  if [ "$#" -eq 1 ]; then
    _is_walked_child_name "$name0" && return 0
    return 1
  fi

  if [ "$name0" = "outputs" ] && [ "$#" -eq 2 ]; then
    [[ "$name1" =~ $UUID_V4_RE ]] && return 0
    return 1
  fi

  if [ "$name0" = "messages" ] && { [ "$#" -eq 2 ] || [ "$#" -eq 3 ]; }; then
    [[ "$name1" =~ $UUID_V4_RE ]] || return 1
    [ "$#" -eq 2 ] && return 0
    [[ "$name2" =~ $UUID_V4_RE ]] && return 0
    return 1
  fi

  if [ "$name0" = "memory" ]; then
    [ "$#" -eq 2 ] && return 0
    [ "$#" -eq 3 ] && [ "$base_rel" = "_quick" ] && return 0
    return 1
  fi

  return 1
}

# classify_walked <root> <relpath>   (Issue #1760)
#
# <relpath> is the path relative to <root> (no leading slash, as produced by
# data_root_ownership's own prefix-stripping below). Returns 0 when
# <relpath> sits at a position the trusted-root walker creates or verifies,
# 1 otherwise. Prints nothing -- the caller only needs the exit code.
#
# The previous design classified by POSITION ALONE via a fixed-depth ERE
# list, which produced false positives on the production tree (Issue
# #1760): a one-segment repo's ad-hoc child (repositories/<a>/<b>, e.g.
# "e_system/templates") sits at the SAME depth as a two-segment slug's own
# base (repositories/<org>/<repo>, e.g. "ms2sato/wsheet"), so a purely
# positional rule cannot tell them apart. This function resolves the
# ambiguity by NAME instead: a segment matching one of WALKED_CHILD_NAMES,
# or the UUID v4 id shape, decides which reading applies.
#
# Splitting <relpath> into segments is done by parameter-expansion
# substring stripping (`${rest%%/*}` / `${rest#*/}`), never by `read`:
# `read` is line-oriented and would silently truncate a path segment that
# contains an embedded newline at the first newline it sees, exactly the
# NUL-safety hazard data_root_ownership's own `-print0` / `read -d ''` loop
# exists to avoid. Plain parameter expansion operates on the whole string as
# an opaque byte sequence and has no such boundary.
#
# Depth accounting: with a one-segment base, messages/<sid>/<wid> is depth 4
# below <root>/repositories; with a two-segment base, depth 5.
# data_root_ownership's `-maxdepth 5` (counted from each find start point)
# covers both.
classify_walked() {
  local root="$1" rel="$2"
  local -a segs=()
  local rest="$rel"
  while [ -n "$rest" ]; do
    segs+=("${rest%%/*}")
    case "$rest" in
      */*) rest="${rest#*/}" ;;
      *) rest="" ;;
    esac
  done
  local n="${#segs[@]}"

  if [ "$n" -eq 1 ]; then
    case "${segs[0]}" in
      _quick | repositories) return 0 ;;
      *) return 1 ;;
    esac
  fi

  if [ "${segs[0]}" = "_quick" ]; then
    _classify_below_walked_base "$root" "_quick" "${segs[@]:1}"
    return $?
  fi

  if [ "${segs[0]}" != "repositories" ]; then
    return 1
  fi

  local a="${segs[1]}"

  if [ "$n" -eq 2 ]; then
    # repositories/<a>: walked iff <a> is a one-segment repo base with a
    # walked child of its own, OR <a> is the org segment of a two-segment
    # slug with at least one repo underneath that itself has a walked
    # child.
    if _has_walked_child "$root" "repositories/${a}" || _org_dir_has_walked_grandchild "$root" "repositories/${a}"; then
      return 0
    fi
    return 1
  fi

  local b="${segs[2]}"

  # Which segment is "the base" is decided by NAME, not depth: a walked
  # child name at segment 2 means <a> is a one-segment base and <b> is the
  # below-base child itself; otherwise <a>/<b> is treated as a two-segment
  # base and the below-base rules apply starting at segment 3.
  if _is_walked_child_name "$b"; then
    _classify_below_walked_base "$root" "repositories/${a}" "${segs[@]:2}"
    return $?
  fi

  if [ "$n" -eq 3 ]; then
    # repositories/<a>/<b>, <b> not a walked child name: walked only if
    # <a>/<b> is itself a used two-segment base (has its own walked child).
    _has_walked_child "$root" "repositories/${a}/${b}" && return 0
    return 1
  fi

  # n >= 4, <b> not a walked child name: <a>/<b> is treated as a
  # two-segment base; below-base rules apply starting at segment 3.
  _classify_below_walked_base "$root" "repositories/${a}/${b}" "${segs[@]:3}"
}

data_root_ownership() {
  local root="$1"
  local service_user="$2"
  local find_cmd="$3"

  if ! command -v "$find_cmd" >/dev/null; then
    echo "cannot run: '$find_cmd' not found" >&2
    return 2
  fi

  # Fail closed (CodeRabbit review on this PR) when the data root itself is
  # not traversable by the caller: without this, a mis-owned or unreadable
  # <data-root> makes BOTH `[ -d "$quick_dir" ]` and `[ -d "$repos_dir" ]`
  # return false (a `[ -d ]` on any path under an untraversable parent fails
  # the same way as a path that does not exist), so the zero-start-points
  # branch below would misreport OWNERSHIP_NO_TREES -- "nothing to check" --
  # for what is actually "could not check". This is a distinct, narrower
  # case than an existing child start point failing mid-walk (already
  # handled by find_rc below): it is the untraversable-ROOT case, checked
  # before start-point discovery even begins.
  if [ ! -d "$root" ] || [ ! -x "$root" ]; then
    echo "cannot run: data root is not an accessible directory: ${root}" >&2
    return 2
  fi

  local quick_dir="${root}/_quick"
  local repos_dir="${root}/repositories"
  local -a start_points=()
  [ -d "$quick_dir" ] && start_points+=("$quick_dir")
  [ -d "$repos_dir" ] && start_points+=("$repos_dir")

  if [ "${#start_points[@]}" -eq 0 ]; then
    echo "OWNERSHIP_NO_TREES"
    echo "INFO: neither '${quick_dir}' nor '${repos_dir}' exists yet -- nothing to check" >&2
    return 0
  fi

  local out_tmp err_tmp find_rc
  out_tmp="$(mktemp)"
  err_tmp="$(mktemp)"
  find_rc=0
  # -print0 / read -d '' (CodeRabbit review on this PR), not -print / plain
  # `read`: a directory name containing an embedded newline would otherwise
  # split into two records at the newline-based read boundary, so a walked
  # position's own relative-path string could arrive at classify_walked
  # already fragmented -- and grep's line-oriented matching over that same
  # fragment compounds it, since grep's ^/$ anchor per LINE, not per
  # record. NUL is the one byte a POSIX filename cannot contain, so it is
  # the only safe delimiter; classify_walked's own segment split (parameter
  # expansion, never `read`) preserves the whole opaque string, including
  # any embedded newline, for the same reason.
  "$find_cmd" "${start_points[@]}" -maxdepth 5 \( -path '*/worktrees/*' -prune \) -o -type d ! -user "$service_user" -print0 >"$out_tmp" 2>"$err_tmp" || find_rc=$?

  # <data-root>'s own group (never a literal) for the chown remedy lines.
  local group
  group="$(stat -c %G "$root" 2>/dev/null)" || group="$service_user"

  local misowned_count=0 misowned_list="" remedy_list="" info_list="" first_three=""
  local path rel matched remedy q_path
  while IFS= read -r -d '' path; do
    [ -n "$path" ] || continue
    rel="${path#"${root}"/}"
    matched=0
    classify_walked "$root" "$rel" && matched=1
    if [ "$matched" -eq 1 ]; then
      misowned_count=$((misowned_count + 1))
      misowned_list="${misowned_list}${path}"$'\n'
      # %q (CodeRabbit review on this PR): the remedy is advisory text an
      # operator may copy-paste; a raw path containing a space or shell
      # metacharacter would otherwise let the shell split or reinterpret it
      # when run verbatim. `--` stops `chown` from reading a leading `-` in
      # the path as an option. `%q` is bash's OWN quoting form, and this
      # whole script family (this lib, the deploy script, the operator's own
      # login shell) is bash -- so the guide's "run the printed chown"
      # instruction stays literally true: paste the remedy line as-is.
      printf -v remedy 'chown -- %q:%q %q' "$service_user" "$group" "$path"
      remedy_list="${remedy_list}${remedy}"$'\n'
      if [ "$misowned_count" -le 3 ]; then
        # Also %q'd: an embedded newline in a raw path here would make the
        # ONE-LINE stderr summary below span multiple physical lines,
        # breaking verify_check's `head -n 1 "$err"` contract (the rest of
        # the summary would silently go missing from the deploy screen).
        printf -v q_path '%q' "$path"
        first_three="${first_three:+${first_three}, }${q_path}"
      fi
    else
      info_list="${info_list}INFO: ignored (not walked): ${path}"$'\n'
    fi
  done <"$out_tmp"

  if [ "$misowned_count" -gt 0 ]; then
    echo "OWNERSHIP_MISOWNED:${misowned_count}"
    printf '%s' "$misowned_list"
    local summary="${misowned_count} walked directory(ies) under ${root} not owned by ${service_user}: ${first_three}"
    if [ "$misowned_count" -gt 3 ]; then
      summary="${summary} ... (+$((misowned_count - 3)) more)"
    fi
    {
      echo "$summary"
      printf '%s' "$remedy_list"
      echo "a mismatch that reaches the running server is logged as: Trusted directory segment has unexpected owner uid=<uid> (expected <service-uid>): <path>"
      printf '%s' "$info_list"
    } >&2
    rm -f "$out_tmp" "$err_tmp"
    return 1
  fi

  if [ "$find_rc" -ne 0 ]; then
    echo "cannot run: find failed: $(head -n 1 "$err_tmp")" >&2
    rm -f "$out_tmp" "$err_tmp"
    return 2
  fi

  echo "OWNERSHIP_OK"
  if [ -n "$info_list" ]; then
    printf '%s' "$info_list" >&2
  fi
  rm -f "$out_tmp" "$err_tmp"
  return 0
}

# unit_env_drift <template> <unit-name> <systemctl-cmd>   (V1, Issue #1688)
#
# Reads the key set from the template's own `^Environment=KEY=` lines (no
# maintained list: a future template key is picked up automatically) and
# compares it against the live unit's EFFECTIVE environment (`systemctl show
# -p Environment --value`, drop-ins included). A missing key means the live
# unit predates a template change and was never re-rendered -- the #1688
# host shape -- and the deploy must not restart into it.
#
# Markers (stdout line 1): DRIFT_NONE | DRIFT_MISSING:<key,...> (return 1) |
# DRIFT_EXECSTART (return 0 with a `WARN:` line on stderr -- promoted to a
# hard FAIL by V3, which compares the running binary itself). Lines 2+ are
# the live `KEY=VALUE` pairs for every template key that IS present, so the
# caller can pass e.g. EMBEDDED_AGENT_BUN_PATH's live value down to V3 from
# this single read.
#
# The ExecStart comparison is derived from the template too: the placeholder
# on the template's `ExecStart=` line (`{{BUN_PATH}}`) is the same
# placeholder that renders `Environment=EMBEDDED_AGENT_BUN_PATH=`, so
# "ExecStart matches the template's unified bun" means "the live ExecStart
# path equals the live value of the Environment key rendered from the same
# placeholder" -- no second copy of the unified path anywhere in this file.
# If no Environment key shares ExecStart's placeholder (a future template
# shape), the ExecStart comparison is skipped; V3 still gates the binary.
#
# Values are read token-wise from the space-separated `show` output; a value
# containing spaces (systemd quotes it) still has its KEY= detected but its
# echoed VALUE is truncated at the first space -- none of the template's keys
# carry such values.
unit_env_drift() {
  local template="$1"
  local unit="$2"
  local systemctl_cmd="$3"
  if [ ! -r "$template" ]; then
    echo "cannot run: unit template '$template' is missing or unreadable" >&2
    return 2
  fi
  if ! command -v "$systemctl_cmd" >/dev/null; then
    echo "cannot run: '$systemctl_cmd' not found -- the live unit's environment cannot be read" >&2
    return 2
  fi
  local template_keys
  template_keys="$(sed -n 's/^Environment=\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$template")"
  if [ -z "$template_keys" ]; then
    echo "cannot run: no Environment=KEY= lines found in '$template'" >&2
    return 2
  fi

  local stderr_tmp
  stderr_tmp="$(mktemp)"
  local show
  if ! show="$("$systemctl_cmd" show -p LoadState -p Environment -p ExecStart "$unit" 2>"$stderr_tmp")"; then
    echo "cannot run: '$systemctl_cmd show $unit' failed ($(tr '\n' ' ' <"$stderr_tmp"))" >&2
    rm -f "$stderr_tmp"
    return 2
  fi
  rm -f "$stderr_tmp"
  local load_state
  load_state="$(printf '%s\n' "$show" | sed -n 's/^LoadState=//p')"
  if [ "$load_state" = "not-found" ]; then
    echo "cannot run: unit '$unit' is not loaded (LoadState=not-found) -- run scripts/setup-multiuser-for-ubuntu.sh first" >&2
    return 2
  fi
  # One token per line, surrounding quotes stripped (systemd quotes values
  # that contain whitespace).
  local live_tokens
  live_tokens="$(printf '%s\n' "$show" | sed -n 's/^Environment=//p' | tr ' ' '\n' | sed 's/^"//; s/"$//')"

  local missing="" present="" key value
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    value="$(printf '%s\n' "$live_tokens" | sed -n "s/^${key}=//p" | head -n 1)"
    # `grep >/dev/null`, not `grep -q`: the check runs under the caller's
    # `set -o pipefail`, and `-q` exits on the first match, which can SIGPIPE
    # the upstream printf (status 141) on a large token list and turn a
    # present key into a false DRIFT_MISSING. A grep that consumes its whole
    # input has no early exit to trigger that.
    if printf '%s\n' "$live_tokens" | grep "^${key}=" >/dev/null; then
      present="${present}${key}=${value}"$'\n'
    else
      missing="${missing:+${missing},}${key}"
    fi
  done <<<"$template_keys"

  if [ -n "$missing" ]; then
    echo "DRIFT_MISSING:${missing}"
    printf '%s' "$present"
    {
      echo "template key(s) missing from the live unit's effective Environment: ${missing} -- the live unit predates a template change and was never re-rendered (this deploy script never renders the unit; scripts/setup-multiuser-for-ubuntu.sh is its single writer). Refusing to restart into it."
      echo "remedy (canonical): scripts/setup-multiuser-for-ubuntu.sh --dry-run <the flags of the original setup, e.g. --port <live-port>> -- review the rendered unit -- then the same with --force, then re-run this deploy"
      echo "remedy (bridge): add the missing Environment= line(s) in a /etc/systemd/system/${unit%.service}.service.d/*.conf drop-in, then systemctl daemon-reload, then re-run this deploy (operator-specific lines belong in a drop-in either way)"
    } >&2
    return 1
  fi

  # ExecStart vs the Environment key rendered from the same placeholder.
  local execstart_placeholder execstart_key live_execstart_path
  execstart_placeholder="$(sed -n 's/^ExecStart=\([^ ]*\).*/\1/p' "$template" | head -n 1)"
  execstart_key=""
  if [ -n "$execstart_placeholder" ]; then
    while IFS= read -r key; do
      [ -n "$key" ] || continue
      if [ "$(sed -n "s/^Environment=${key}=//p" "$template" | head -n 1)" = "$execstart_placeholder" ]; then
        execstart_key="$key"
        break
      fi
    done <<<"$template_keys"
  fi
  if [ -n "$execstart_key" ]; then
    live_execstart_path="$(printf '%s\n' "$show" | sed -n 's/^ExecStart=.*{ path=\([^ ;]*\).*/\1/p' | head -n 1)"
    value="$(printf '%s' "$present" | sed -n "s/^${execstart_key}=//p" | head -n 1)"
    if [ -n "$live_execstart_path" ] && [ "$live_execstart_path" != "$value" ]; then
      echo "DRIFT_EXECSTART"
      printf '%s' "$present"
      echo "WARN: the live ExecStart runs '${live_execstart_path}' but ${execstart_key}='${value}' -- the template renders both from the same placeholder, so the unit's own binary and the one the embedded agent will spawn differ (Issue #1222 drift). A warning in this version; V3 (mainpid-identity) is where this becomes a hard FAIL. Remedy: scripts/setup-multiuser-for-ubuntu.sh --dry-run then --force, then re-run this deploy." >&2
      return 0
    fi
  fi

  echo "DRIFT_NONE"
  printf '%s' "$present"
  return 0
}

# entry_path_readable <entry-path> <map-path> <elevate>   (V2, Issues #1668 / #1690)
#
# The existing unprivileged readability probe on both unified paths,
# unchanged in what it asks (`runuser -u nobody -- test -r`), reported
# through the three-way contract above instead of assert_readable_by_
# unprivileged_user's two-way fail-closed one: READABLE -> 0, UNREADABLE ->
# 1, no marker (elevation / runuser refused) or no runuser -> 2.
#
# Markers: READABLE | UNREADABLE:<path> | PROBE_FAILED:<path> | NO_RUNUSER.
entry_path_readable() {
  local entry_path="$1"
  local map_path="$2"
  local elevate="${3:-}"
  local p marker stderr_tmp captured_stderr
  for p in "$entry_path" "$map_path"; do
    stderr_tmp="$(mktemp)"
    marker="$(readability_probe_marker "$p" "$elevate" 2>"$stderr_tmp")"
    captured_stderr="$(cat "$stderr_tmp")"
    rm -f "$stderr_tmp"
    case "$marker" in
      READABLE)
        ;;
      NO_RUNUSER)
        echo "NO_RUNUSER"
        echo "cannot run: runuser (util-linux) not found -- required for the unprivileged readability probe" >&2
        return 2
        ;;
      UNREADABLE)
        echo "UNREADABLE:${p}"
        echo "'$p' is not readable by an unprivileged user (probed as 'nobody' via runuser -- any real elevation-target user hits the same wall) -- step 5/6 (copy to the unified entry path) did not complete, or its directory is not world-traversable; re-run this deploy" >&2
        return 1
        ;;
      *)
        echo "PROBE_FAILED:${p}"
        echo "cannot run: readability probe for '$p' could not run -- elevation or runuser itself failed before the readability check could complete (${captured_stderr:-no diagnostic output captured})" >&2
        return 2
        ;;
    esac
  done
  echo "READABLE"
  return 0
}

# mainpid_identity <unit-name> <configured-bun> <elevate> <systemctl-cmd>   (V3, Issues #1222 / #1291 / #1688)
#
# Compares the binary the unit's main process is actually running
# (`/proc/<MainPID>/exe`) with the one the embedded agent will spawn
# (<configured-bun>, the live unit's EMBEDDED_AGENT_BUN_PATH value read by
# V1). The comparison itself is the production `compareBinaryIdentity`
# (packages/server/src/lib/embedded-agent-bun-path-check.ts), reached through
# the sibling entry embedded-agent-bun-identity.ts, which prints ONE marker.
#
# `/proc/<pid>/exe` is PTRACE_MODE_READ-gated: without CAP_SYS_PTRACE the
# reader must share BOTH the uid and the gid of the target (measured on the
# dogfood host in #1688 and on the tier-3 runner: a matching uid with the
# wrong primary gid still gets EACCES). So the entry runs as the unit's own
# `User=` AND `Group=` via `<elevate> runuser -u <User> -g <Group> --
# <configured-bun> <entry> <MainPID> <configured-bun>` -- the configured bun
# is also the interpreter, so no second copy of the unified path lives here
# (on any unit that passed V1 the two render from the same placeholder).
#
# Markers: SAME (0) | DIFFERENT (1) | UNRESOLVABLE:self | UNRESOLVABLE:configured
# | UNRESOLVABLE:bare | MAINPID_0 | NO_MARKER (all 2, naming what to fix).
mainpid_identity() {
  local unit="$1"
  local configured="$2"
  local elevate="${3:-}"
  local systemctl_cmd="$4"
  if ! command -v "$systemctl_cmd" >/dev/null; then
    echo "cannot run: '$systemctl_cmd' not found -- the unit's MainPID cannot be read" >&2
    return 2
  fi
  local stderr_tmp show
  stderr_tmp="$(mktemp)"
  if ! show="$("$systemctl_cmd" show -p MainPID -p User -p Group "$unit" 2>"$stderr_tmp")"; then
    echo "cannot run: '$systemctl_cmd show $unit' failed ($(tr '\n' ' ' <"$stderr_tmp"))" >&2
    rm -f "$stderr_tmp"
    return 2
  fi
  rm -f "$stderr_tmp"
  local pid user group
  pid="$(printf '%s\n' "$show" | sed -n 's/^MainPID=//p')"
  user="$(printf '%s\n' "$show" | sed -n 's/^User=//p')"
  group="$(printf '%s\n' "$show" | sed -n 's/^Group=//p')"
  if [ -z "$pid" ] || [ "$pid" = "0" ]; then
    echo "MAINPID_0"
    echo "cannot run: '$unit' has no main process (MainPID=${pid:-unset}) -- the unit is not running, so there is no running binary to compare; see the unit-active check" >&2
    return 2
  fi
  if [ -z "$user" ] || [ -z "$group" ]; then
    echo "NO_MARKER"
    echo "cannot run: '$unit' reports User='${user}' Group='${group}' -- the identity entry must run as the unit's own User= AND Group= to read /proc/${pid}/exe, and one of them is unset" >&2
    return 2
  fi
  case "$configured" in
    /*) ;;
    *)
      echo "UNRESOLVABLE:bare"
      echo "cannot run: EMBEDDED_AGENT_BUN_PATH is the bare name '${configured}', which resolves per elevation-target user's PATH (the #1221 class) -- nothing a single realpath could compare; set it to an absolute path (re-render the unit: scripts/setup-multiuser-for-ubuntu.sh --dry-run then --force)" >&2
      return 2
      ;;
  esac
  local entry
  entry="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/embedded-agent-bun-identity.ts"
  stderr_tmp="$(mktemp)"
  local marker
  # shellcheck disable=SC2086 # $elevate: see readability_probe_marker.
  marker="$(${elevate} runuser -u "$user" -g "$group" -- "$configured" "$entry" "$pid" "$configured" 2>"$stderr_tmp" || true)"
  local captured_stderr
  captured_stderr="$(cat "$stderr_tmp")"
  rm -f "$stderr_tmp"
  case "$marker" in
    SAME)
      echo "SAME"
      return 0
      ;;
    DIFFERENT)
      echo "DIFFERENT"
      echo "the unit's main process (pid ${pid}) runs a binary other than the one the embedded agent will spawn ('${configured}') -- the #1688 failure shape: the live ExecStart drifted from the template's unified bun. Re-render the unit (scripts/setup-multiuser-for-ubuntu.sh --dry-run then --force) and re-run this deploy." >&2
      return 1
      ;;
    UNRESOLVABLE:self)
      echo "UNRESOLVABLE:self"
      echo "cannot run: /proc/${pid}/exe could not be resolved even as the unit's own User=${user} AND Group=${group} -- the identity check itself could not read the running binary (not a proof that the binaries differ); check that the unit's process really runs as ${user}:${group} (systemctl show -p User -p Group, grep Uid/Gid /proc/${pid}/status)" >&2
      return 2
      ;;
    UNRESOLVABLE:configured)
      echo "UNRESOLVABLE:configured"
      echo "cannot run: the configured EMBEDDED_AGENT_BUN_PATH '${configured}' could not be resolved as ${user}:${group} (missing, or an ancestor directory is not traversable) -- the embedded agent would fail to spawn it for the same reason; check the path and its directory modes (${captured_stderr:-no diagnostic output captured})" >&2
      return 2
      ;;
    UNRESOLVABLE:bare)
      echo "UNRESOLVABLE:bare"
      echo "cannot run: the identity entry reports a bare EMBEDDED_AGENT_BUN_PATH ('${configured}') -- set it to an absolute path and re-render the unit" >&2
      return 2
      ;;
    *)
      echo "NO_MARKER"
      echo "cannot run: no identity marker was produced -- elevation, runuser (as ${user}:${group}), the bun at '${configured}', or the identity entry itself failed before printing one (${captured_stderr:-no diagnostic output captured})" >&2
      return 2
      ;;
  esac
}

# unit_active <unit-name> <systemctl-cmd> [journalctl-cmd] [elevate]   (V4)
#
# `systemctl is-active <unit>` == active -> PASS. Any other state -> FAIL
# with `systemctl status` (10 lines) and the last 20 journal lines attached
# on stderr. An empty state (systemctl present but unable to answer, e.g. no
# systemd on this host) -> cannot run. The diagnostics read the journal,
# which is root / adm / systemd-journal readable only, hence [elevate].
#
# Markers: ACTIVE | NOT_ACTIVE:<state>.
unit_active() {
  local unit="$1"
  local systemctl_cmd="$2"
  local journalctl_cmd="${3:-journalctl}"
  local elevate="${4:-}"
  if ! command -v "$systemctl_cmd" >/dev/null; then
    echo "cannot run: '$systemctl_cmd' not found -- the unit's state cannot be read" >&2
    return 2
  fi
  local stderr_tmp state
  stderr_tmp="$(mktemp)"
  state="$("$systemctl_cmd" is-active "$unit" 2>"$stderr_tmp" || true)"
  if [ -z "$state" ]; then
    echo "cannot run: '$systemctl_cmd is-active $unit' produced no state ($(tr '\n' ' ' <"$stderr_tmp"))" >&2
    rm -f "$stderr_tmp"
    return 2
  fi
  rm -f "$stderr_tmp"
  if [ "$state" = "active" ]; then
    echo "ACTIVE"
    return 0
  fi
  echo "NOT_ACTIVE:${state}"
  {
    echo "'$unit' is '${state}', not 'active' after the restart"
    echo "--- systemctl status (10 lines) ---"
    # shellcheck disable=SC2086 # $elevate: see readability_probe_marker.
    ${elevate} "$systemctl_cmd" status "$unit" --no-pager 2>&1 | head -n 10 || true
    echo "--- last 20 journal lines ---"
    # shellcheck disable=SC2086
    ${elevate} "$journalctl_cmd" -u "$unit" -n 20 --no-pager -o cat 2>&1 || true
  } >&2
  return 1
}

# health <port> [attempts] [curl-cmd]   (V5)
#
# `GET http://localhost:<port>/api/config` (no auth): HTTP 200 AND the body
# carries `"authMode":"multi-user"` -> PASS. Polls up to [attempts] times
# one second apart (default 10) before giving up, because this is the first
# check after the restart that waits for the server to come up -- the
# journal digest after it then reads a settled boot. Any other status after
# the last attempt, or 200 with another mode -> FAIL naming both. `curl`
# absent -> cannot run. Replaces the old `/api/auth/me` probe, whose 401/200
# depended on auth semantics a health check should not.
#
# Markers: HEALTH_OK | HEALTH_HTTP:<code> | HEALTH_WRONG_MODE:<mode|absent>.
health() {
  local port="$1"
  local attempts="${2:-10}"
  local curl_cmd="${3:-curl}"
  if ! command -v "$curl_cmd" >/dev/null; then
    echo "cannot run: '$curl_cmd' not found -- the health endpoint cannot be probed" >&2
    return 2
  fi
  local url="http://localhost:${port}/api/config"
  local body code="000" i
  body="$(mktemp)"
  for ((i = 1; i <= attempts; i++)); do
    code="$("$curl_cmd" -s -m 5 -o "$body" -w '%{http_code}' "$url" 2>/dev/null || true)"
    [ "$code" = "200" ] && break
    [ "$i" -lt "$attempts" ] && sleep 1
  done
  if [ "$code" = "200" ]; then
    if grep -q '"authMode":"multi-user"' "$body"; then
      rm -f "$body"
      echo "HEALTH_OK"
      return 0
    fi
    local mode
    mode="$(sed -n 's/.*"authMode":"\([^"]*\)".*/\1/p' "$body" | head -n 1)"
    rm -f "$body"
    echo "HEALTH_WRONG_MODE:${mode:-absent}"
    echo "GET ${url} returned HTTP 200 but authMode is '${mode:-absent}', not 'multi-user' -- the unit is not running with AUTH_MODE=multi-user (check Environment=AUTH_MODE= in the live unit)" >&2
    return 1
  fi
  rm -f "$body"
  echo "HEALTH_HTTP:${code:-000}"
  echo "GET ${url} returned HTTP ${code:-000} (000 = no response) after ${attempts} attempt(s) -- the server did not answer HTTP 200 on port ${port}; see the unit-active and journal-digest checks" >&2
  return 1
}

# journal_digest <unit-name> <since-timestamp> <journalctl-cmd> [elevate]   (V6)
#
# `journalctl -u <unit> --since <ts> -o cat` (the raw message text, i.e. the
# server's JSON log lines): the three boot lines the code emits on purpose
# must all be present -- `Server starting` with `"env":"production"`
# (packages/server/src/index.ts), `User mode initialized` with
# `"authMode":"multi-user"` (packages/server/src/app-context.ts), `Server
# listening` (index.ts) -- and NO `"level":40` (warn) line from
# assessEmbeddedAgentBunPath (packages/server/src/lib/embedded-agent-bun-
# path-check.ts): four of its five warnings carry the literal
# `EMBEDDED_AGENT_BUN_PATH`, the fifth (the server's own binary could not be
# resolved) says "bun-path identity check could not run". Such a warning
# after a deploy means the unit's bun and the embedded agent's bun still
# differ (or the configured path is unreachable) even though V1 passed. The
# `AUTH_COOKIE_SECURE=false` warning (index.ts, an operator choice on a
# trusted private network) is reported as an `INFO:` annotation, never a
# FAIL. <since-timestamp> is captured by the caller IMMEDIATELY BEFORE the
# restart. The journal is root / adm / systemd-journal readable only, hence
# [elevate].
#
# Markers: JOURNAL_OK | JOURNAL_MISSING:<line;...> | JOURNAL_BUN_PATH_WARNING.
journal_digest() {
  local unit="$1"
  local since="$2"
  local journalctl_cmd="$3"
  local elevate="${4:-}"
  if ! command -v "$journalctl_cmd" >/dev/null; then
    echo "cannot run: '$journalctl_cmd' not found -- the unit's journal cannot be read" >&2
    return 2
  fi
  local stderr_tmp lines
  stderr_tmp="$(mktemp)"
  # shellcheck disable=SC2086 # $elevate: see readability_probe_marker.
  if ! lines="$(${elevate} "$journalctl_cmd" -u "$unit" --since "$since" -o cat --no-pager 2>"$stderr_tmp")"; then
    echo "cannot run: '$journalctl_cmd -u $unit --since \"$since\"' failed ($(tr '\n' ' ' <"$stderr_tmp"))" >&2
    rm -f "$stderr_tmp"
    return 2
  fi
  rm -f "$stderr_tmp"

  # Every match below is `grep ... >/dev/null`, never `grep -q`: this check
  # runs under the caller's `set -o pipefail` on an unbounded journal, and a
  # `-q` that exits on the first match can SIGPIPE the upstream stage
  # (status 141) once the buffer exceeds the pipe size -- measured: 3000
  # matching lines (~168 KiB) turned a present `Server starting` into a
  # false JOURNAL_MISSING, i.e. a false deploy FAIL. A grep that reads its
  # whole input has no early exit to trigger that.
  local missing=""
  printf '%s\n' "$lines" | grep -F 'Server starting' | grep '"env":"production"' >/dev/null \
    || missing="${missing:+${missing};}Server starting (env: production)"
  printf '%s\n' "$lines" | grep -F 'User mode initialized' | grep '"authMode":"multi-user"' >/dev/null \
    || missing="${missing:+${missing};}User mode initialized (authMode: multi-user)"
  printf '%s\n' "$lines" | grep -F 'Server listening' >/dev/null \
    || missing="${missing:+${missing};}Server listening"
  local bun_warning cookie_warning
  bun_warning="$(printf '%s\n' "$lines" | grep -F '"level":40' | grep -E 'EMBEDDED_AGENT_BUN_PATH|bun-path identity check could not run' | head -n 1 | cut -c1-300 || true)"
  cookie_warning="$(printf '%s\n' "$lines" | grep -F '"level":40' | grep -F 'AUTH_COOKIE_SECURE=false' | head -n 1 || true)"

  if [ -n "$missing" ]; then
    echo "JOURNAL_MISSING:${missing}"
    echo "required boot line(s) absent from the journal since ${since}: ${missing} -- the server did not complete its boot as a production multi-user unit (or the timestamp precedes the restart by too much / the journal is filtered); see the unit-active check and 'journalctl -u ${unit} --since \"${since}\"'" >&2
    [ -n "$cookie_warning" ] && echo "INFO: AUTH_COOKIE_SECURE=false is set (the Secure cookie attribute is off) -- an operator choice for a trusted private network, not a fault" >&2
    return 1
  fi
  if [ -n "$bun_warning" ]; then
    echo "JOURNAL_BUN_PATH_WARNING"
    echo "the server logged an EMBEDDED_AGENT_BUN_PATH warning at boot -- the unit's bun and the embedded agent's bun still differ, or the configured path is unreachable, even though the unit's Environment carries the key: ${bun_warning}" >&2
    [ -n "$cookie_warning" ] && echo "INFO: AUTH_COOKIE_SECURE=false is set (the Secure cookie attribute is off) -- an operator choice for a trusted private network, not a fault" >&2
    return 1
  fi
  echo "JOURNAL_OK"
  [ -n "$cookie_warning" ] && echo "INFO: AUTH_COOKIE_SECURE=false is set (the Secure cookie attribute is off) -- an operator choice for a trusted private network, not a fault" >&2
  return 0
}

# Direct-invocation entry point for tests (Issue #1222, extended #1668): when
# this file is executed directly (not sourced), dispatch on an explicit
# subcommand name rather than argument count -- an arity-based dispatch is an
# implicit contract that breaks silently the day either function grows an
# optional argument, so the subcommand is spelled out instead. This lets
# scripts/__tests__/setup-multiuser-checks.test.mjs spawn this file as a
# plain executable (`spawnSync(LIB, [...])`) instead of building a
# `bash -c '...'` command string -- no shell ever parses a dynamic value,
# which is the structural (not merely argv-separated) fix for the CodeQL
# js/shell-command-injection-from-environment false positive that flagged
# the earlier `bash -c script bash "$LIB" "$path"` form (that form passed
# values as real, unparsed positional parameters and was already
# injection-safe, but CodeQL's taint analysis does not model that -- it
# flags any tainted value reaching a spawnSync call whose command is a shell
# interpreter, regardless of whether the value lands in the command string
# or a separate argv slot).
#
# The no-subcommand form (`spawnSync(LIB, [path])`) is preserved byte-for-byte
# for assert_unified_bun_executable so the pre-existing test in
# setup-multiuser-checks.test.mjs (Issue #1222) needs no change.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  case "${1:-}" in
    assert-readable-file)
      shift
      assert_readable_file "$@"
      ;;
    assert-readable-by-unprivileged-user)
      shift
      assert_readable_by_unprivileged_user "$@"
      ;;
    dist-artifact-present)
      shift
      dist_artifact_present "$@"
      ;;
    resolve-health-port)
      shift
      resolve_health_port "$@"
      ;;
    data-root-ownership)
      shift
      data_root_ownership "$@"
      ;;
    unit-env-drift)
      shift
      unit_env_drift "$@"
      ;;
    entry-path-readable)
      shift
      entry_path_readable "$@"
      ;;
    mainpid-identity)
      shift
      mainpid_identity "$@"
      ;;
    unit-active)
      shift
      unit_active "$@"
      ;;
    health)
      shift
      health "$@"
      ;;
    journal-digest)
      shift
      journal_digest "$@"
      ;;
    *)
      assert_unified_bun_executable "$@"
      ;;
  esac
fi
