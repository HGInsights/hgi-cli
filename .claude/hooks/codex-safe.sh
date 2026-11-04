#!/bin/bash
# codex-safe.sh — strip credentials and bound the run before invoking an
# external agent CLI.
#
# Usage: codex-safe.sh exec -m <model> -s read-only -o out.md "prompt"
#
# Three guards, all enforced HERE rather than at each call site, because every
# call site that had to remember one of them eventually forgot.
#
#   1. CREDENTIAL STRIPPING. A hardcoded unset-list silently rots as new
#      secrets are added to your .env, so this strips by NAME PATTERN first and
#      then unsets known-name exceptions that don't match (e.g. DATABASE_URL).
#
#   2. STDIN CLOSED (`</dev/null`) when stdin is a non-TTY pipe. `codex exec`
#      reads instructions from stdin when stdin is piped and appends them to
#      any positional prompt. Inside a coding-agent subagent the shell's stdin
#      is an open pipe that never reaches EOF, so codex blocks forever waiting
#      for input that never arrives — observed in production as a ~25-minute
#      hang producing 0 bytes, which silently forced the fallback reviewer in
#      every review loop. Redirecting from /dev/null gives an immediate EOF.
#      An interactive TTY is left alone, and `CODEX_SAFE_STDIN=inherit` opts
#      back into real stdin for a caller that genuinely pipes input.
#
#   3. WALL-CLOCK TIMEOUT. macOS ships no `timeout`/`gtimeout`, so a `timeout`
#      written into an agent definition is INERT and a hang is never actually
#      bounded. perl's alarm is always present; we kill the whole process group
#      so a wedged child can't outlive the parent.
#
# Codex accounts (the AI harness's; see codex-lib.sh). With
# `codex <name> <dir>` lines in the harness's accounts.conf, each run tries them in file order with CODEX_HOME=<dir>,
# skipping an account with an unexpired limit record or one whose
# `codex login status` fails, and prints `codex-safe: account <name>` to stderr
# before it runs. A run that exits non-zero with codex's own usage-limit line
# (column 0, see codex-lib.sh) writes that account's limit record and the SAME
# arguments run again on the next account. Every retry runs inside the one
# CODEX_TIMEOUT_SECS bound below, not a fresh one per account. Output streams
# to the caller as before; a copy of each attempt is kept only to look for the
# limit line. Timeouts, crashes and other errors never switch accounts, and
# neither does a `codex login status` that fails other than "Not logged in".
# An account out of credits (codex's "ERROR: Your workspace is out
# of credits" line) is handled the same way; that line names no reset, so its
# record holds for one hour and the account is tried again after that.
# With no codex lines, codex runs with the inherited environment, as before;
# its usage-limit line is recorded as account `default`, and
# that record never skips a run.
# CODEX_SAFE_ACCOUNT_FILE=<path> (set by the reviewer agents): the wrapper
# writes there which account ran (see note_account), a channel codex's echo of
# the prompt can't fake; the `codex-safe:` stderr lines are for people.
#
# Exit codes follow shell convention so a caller can tell outcomes apart:
#   124        timed out (GNU timeout's convention)
#   128+signal codex died from a signal — NOT reported as success
#   75         no codex ran: every Codex account is at its usage limit, out of
#              credits or not logged in; one `codex-safe:` line on stderr names
#              the earliest reset (the earliest retry when any is out of
#              credits)
#   2          accounts.conf can't be read, or a codex line in it is malformed
#   otherwise  codex's own exit code
#
# Upstream documents this wrapper in review-loops.md §4; that file is not
# vendored in this repo, so this header is the reference here.
set -euo pipefail

# Override with CODEX_TIMEOUT_SECS for a long review; 0 disables the bound.
CODEX_TIMEOUT_SECS="${CODEX_TIMEOUT_SECS:-900}"

# Any var whose name looks credential-bearing.
PATTERN='(SECRET|TOKEN|API_?KEY|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|AUTH)'

# Explicit names that carry secrets but don't match the pattern above.
EXTRA=(
  DATABASE_URL TEST_DATABASE_URL REDIS_URL
  AUTH_GOOGLE_ID AWS_SESSION_TOKEN
  CODEX_SAFE_SELF
)

strip_env() {
  local unset_args=()
  local name
  while IFS='=' read -r name _; do
    [[ "$name" =~ $PATTERN ]] && unset_args+=(-u "$name")
  done < <(env)

  for name in "${EXTRA[@]}"; do
    unset_args+=(-u "$name")
  done

  env "${unset_args[@]}" codex "$@"
}

run_codex() {
  # The DEFAULT is to discard stdin, because the common case — an agent passing
  # the prompt positionally from a shell whose stdin is a pipe that never EOFs —
  # otherwise hangs forever, and a hang is far worse than a discarded pipe.
  if [[ "${CODEX_SAFE_STDIN:-}" == "inherit" ]] || [[ -t 0 ]]; then
    strip_env "$@"
  else
    strip_env "$@" </dev/null
  fi
}

# Real directory of this script, for codex-lib.sh next to it.
case $0 in
  */*) CODEX_SAFE_DIR=${0%/*} ;;
  *) CODEX_SAFE_DIR=$(dirname -- "$(command -v -- "$0")") ;;
esac

# note_account TEXT: tell the caller which account ran, through the file it
# named in CODEX_SAFE_ACCOUNT_FILE, never through the log, where codex's echo of
# the prompt could fake a line. One line, rewritten on each attempt:
#   none                  no codex lines: the inherited environment ran
#   account <name>        codex ran on <name> (the last attempt's)
#   unavailable <reason>  exit 75: no account had room
#   error <reason>        exit 2: accounts.conf can't be used
note_account() {
  if [[ -n "${CODEX_SAFE_ACCOUNT_FILE:-}" ]]; then
    printf '%s\n' "$1" >"$CODEX_SAFE_ACCOUNT_FILE" 2>/dev/null || :
  fi
}

# run_default ARGS...: no codex lines, so codex runs with the inherited
# environment, as before. Issue #58: on codex's own usage-limit line the
# limit is recorded as account `default`, which the reconciler reads (through
# `harness-account codex-status`) before rerunning an in-model review on
# Codex. The record never skips a run here: every review still tries Codex.
# Never returns.
run_default() {
  local rc=0 line tmpd
  tmpd=$(mktemp -d "${TMPDIR:-/tmp}/codex-safe.XXXXXX") || {
    run_codex "$@"
    exit $?
  }
  # shellcheck disable=SC2064 # expand now: tmpd is local
  trap "rm -rf -- '$tmpd'" EXIT
  trap 'exit 143' TERM
  trap 'exit 130' INT
  trap 'exit 129' HUP
  printf '%s\n' "$@" >"$tmpd/args"
  { run_codex "$@" 2>&1 1>&3 | tee "$tmpd/err" >&2; } 3>&1 || rc=$?
  if [[ $rc -eq 0 || $rc -eq 124 || $rc -ge 128 ]]; then exit "$rc"; fi
  line=$(_cx_detect "$tmpd/args" "$tmpd/err")
  if [[ -n "$line" ]] && ! _cx_record default "$line" >/dev/null; then
    if [[ $(_cx_reason "$line") == "out of credits" ]]; then
      echo "codex-safe: codex is out of credits, but its limit record could not be written to $_cx_limits" >&2
    else
      echo "codex-safe: codex is at its usage limit, but its limit record could not be written to $_cx_limits" >&2
    fi
  fi
  exit "$rc"
}

# run_accounts ARGS...: pick a Codex account and fail over on a usage limit
# (header). Never returns.
run_accounts() {
  local i rc name home lim e d why limited="" earliest="" earliest_disp="" logged_out="" credits="" line now tmpd
  local probe msg
  # shellcheck source=SCRIPTDIR/codex-lib.sh
  if ! . "$CODEX_SAFE_DIR/codex-lib.sh"; then
    echo "codex-safe: cannot load $CODEX_SAFE_DIR/codex-lib.sh" >&2
    note_account "error cannot load codex-lib.sh"
    exit 2
  fi
  if ! _cx_paths; then
    note_account none
    run_codex "$@" # no usable HOME: no registry, as before
    exit $?
  fi
  rc=0
  _cx_load || rc=$?
  if [[ $rc -ne 0 ]]; then
    echo "codex-safe: $_cx_err" >&2
    note_account "error $_cx_err"
    exit 2
  fi
  if [[ ${#_cx_names[@]} -eq 0 ]]; then
    note_account none
    run_default "$@"
  fi
  tmpd=$(mktemp -d "${TMPDIR:-/tmp}/codex-safe.XXXXXX")
  # shellcheck disable=SC2064 # expand now: tmpd is local
  trap "rm -rf -- '$tmpd'" EXIT
  # The timeout's group TERM must still run the EXIT trap.
  trap 'exit 143' TERM
  trap 'exit 130' INT
  trap 'exit 129' HUP
  # Every line of what we send: codex echoes the prompt once, so that many
  # copies of each are skipped before _cx_detect looks at codex's last line.
  printf '%s\n' "$@" >"$tmpd/args"
  for ((i = 0; i < ${#_cx_names[@]}; i++)); do
    name=${_cx_names[$i]}
    home=${_cx_homes[$i]}
    lim=$(_cx_limit "$name")
    if [[ -n "$lim" ]]; then
      IFS=$'\t' read -r e d why _ <<<"$lim"
      if [[ $why == "out of credits" ]]; then
        echo "codex-safe: account $name is out of credits; retry after $d; skipped" >&2
        credits+="${credits:+, }$name"
      else
        echo "codex-safe: account $name is at its usage limit until $d; skipped" >&2
      fi
      limited+="${limited:+, }$name"
      if [[ -z "$earliest" || $e -lt $earliest ]]; then
        earliest=$e
        earliest_disp=$d
      fi
      continue
    fi
    # Skipped only when it says so: codex's exit 1 with "Not logged in"
    # (codex-cli 0.163.0), or no dir at all (codex would create it). A probe
    # that fails any other way doesn't switch accounts: the run goes ahead
    # and fails or succeeds on its own.
    rc=0
    if [[ -d "$home" ]]; then
      # shellcheck disable=SC2030 # CODEX_HOME for this subshell only
      probe=$( (export CODEX_HOME="$home"; strip_env login status) 2>&1 </dev/null) || rc=$?
    else
      probe="Not logged in" rc=1
    fi
    if [[ $rc -eq 1 && "$probe" == *"Not logged in"* ]]; then
      echo "codex-safe: account $name is not logged in; skipped (fix: bin/harness-account codex-setup $name)" >&2
      logged_out+="${logged_out:+, }$name"
      continue
    fi
    echo "codex-safe: account $name" >&2
    note_account "account $name"
    : >"$tmpd/err"
    rc=0
    # Stream as before; tee a copy of stderr, where codex prints its error
    # last, to look for the limit line (codex-lib.sh, _CX_LIMIT_RE).
    # shellcheck disable=SC2031 # set in its own subshell
    { (export CODEX_HOME="$home"; run_codex "$@") 2>&1 1>&3 | tee "$tmpd/err" >&2; } 3>&1 || rc=$?
    if [[ $rc -eq 0 || $rc -eq 124 || $rc -ge 128 ]]; then exit "$rc"; fi
    line=$(_cx_detect "$tmpd/args" "$tmpd/err")
    [[ -n "$line" ]] || exit "$rc"
    now=$(_cx_now)
    # From codex's line, not the record: the wording holds when it can't be written.
    why=$(_cx_reason "$line")
    if lim=$(_cx_record "$name" "$line" "$now"); then
      IFS=$'\t' read -r e d _ <<<"$lim"
    else
      if [[ $why == "out of credits" ]]; then
        echo "codex-safe: account $name is out of credits, but its limit record could not be written to $_cx_limits" >&2
      else
        echo "codex-safe: account $name is at its usage limit, but its limit record could not be written to $_cx_limits" >&2
      fi
      lim=$(_cx_pl parse "$line" "$now")
      e=${lim%%$'\t'*}
      d="${lim#*$'\t'} (unrecorded)"
    fi
    if [[ $why == "out of credits" ]]; then
      echo "codex-safe: account $name is out of credits; retry after $d; trying the next account" >&2
      credits+="${credits:+, }$name"
    else
      echo "codex-safe: account $name is at its usage limit until $d; trying the next account" >&2
    fi
    limited+="${limited:+, }$name"
    if [[ -z "$earliest" || $e -lt $earliest ]]; then
      earliest=$e
      earliest_disp=$d
    fi
  done
  # One contract (Requirement 5): this line, whatever the mix. "none" when no
  # account had a record (every one is logged out); logged-out names follow.
  # Issue #96: an out-of-credits account's time is a retry, not a reset.
  if [[ -n "$credits" ]]; then
    msg="every Codex account is at its usage limit or out of credits; earliest retry ${earliest_disp:-none}; out of credits: $credits"
  else
    msg="every Codex account is at its usage limit; earliest reset ${earliest_disp:-none}"
  fi
  if [[ -n "$logged_out" ]]; then
    msg+="; not logged in: $logged_out (fix: bin/harness-account codex-setup <name>)"
  fi
  echo "codex-safe: $msg" >&2
  note_account "unavailable $msg"
  exit 75
}

if [[ "$CODEX_TIMEOUT_SECS" == "0" ]]; then
  run_accounts "$@"       # documented, explicit opt-out of the bound
fi

# The perl guard below re-execs THIS script for the child, which must run codex
# directly rather than nesting a second timeout. The handoff is a leading ARGV
# sentinel, not an env var: the caller's environment cannot forge an argument,
# so this cannot be spoofed into silently skipping the bound.
# `CODEX_TIMEOUT_SECS=0` above remains the one supported way to opt out.
readonly CODEX_SAFE_SENTINEL="--codex-safe-internal-child"
if [[ "${1:-}" == "$CODEX_SAFE_SENTINEL" ]]; then
  shift
  run_accounts "$@"
fi

# `setsid`-free process-group kill: perl forks, the child becomes its own group
# leader via POSIX::setpgid, and on alarm we signal the negated pgid so codex and
# anything it spawned all die. Without the group kill, killing perl's immediate
# child can leave codex running and holding the terminal.
export CODEX_SAFE_SELF="$0"
perl -e '
  use POSIX qw(setpgid);
  my $secs = shift @ARGV;
  my $pid = fork();
  die "fork failed: $!" unless defined $pid;
  if ($pid == 0) {
    setpgid(0, 0);
    exec($ENV{CODEX_SAFE_SELF}, @ARGV) or die "exec failed: $!";
  }
  setpgid($pid, $pid);

  my $reap = sub {
    my ($sig) = @_;
    kill("TERM", -$pid);
    sleep 2;
    kill("KILL", -$pid);
    return $sig;
  };

  local $SIG{ALRM} = sub {
    $reap->("ALRM");
    print STDERR "codex-safe: TIMED OUT after ${secs}s\n";
    exit 124;
  };
  # Forward interactive/terminating signals to the whole group, else killing this
  # wrapper leaves codex running detached in its own process group.
  for my $sig (qw(INT TERM HUP)) {
    $SIG{$sig} = sub {
      $reap->($sig);
      my %num = (INT => 2, TERM => 15, HUP => 1);
      exit(128 + $num{$sig});
    };
  }

  alarm($secs);
  waitpid($pid, 0);
  my $status = $?;
  alarm(0);

  # A signalled death must NOT look like success: `$? >> 8` is 0 for signal
  # exits, so report 128+signal the way a shell does.
  my $signal = $status & 127;
  exit($signal ? 128 + $signal : $status >> 8);
' "$CODEX_TIMEOUT_SECS" "$CODEX_SAFE_SENTINEL" "$@"
