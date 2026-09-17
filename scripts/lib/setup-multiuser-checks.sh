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

# ---------------------------------------------------------------------------
# Post-deploy verification checks V1-V6 (Issue #1717, absorbing #1688).
#
# scripts/update-and-deploy-for-multiuser-ubuntu.sh runs these in order --
# V1 BEFORE `systemctl restart` (fail-closed), V2-V6 after it -- and prints
# one PASS / FAIL / SKIP line per check. Spec: the "Post-deploy verification
# -- checks enumerated" table in docs/design/elevation-verification-tiers.md.
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
