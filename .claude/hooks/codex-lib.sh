#!/bin/bash
# codex-lib.sh: the AI harness's Codex accounts. Sourced, not run, by
# .claude/hooks/codex-safe.sh (and, in the harness itself, by its account and
# preflight commands). A copy of the harness's own file: change both together.
# Without a harness accounts.conf it finds no accounts, and codex-safe.sh runs
# codex with the inherited environment.
#
# A Codex account is a CODEX_HOME of its own, ~/.codex-accounts/<name>,
# registered as a `codex <name> <dir>` line in accounts.conf. ~/.codex is the
# operator's own Codex and is never one unless registered.
#
# A limit record, <config>/ai-harness/codex-limits/<name>.json, holds
# {resets_at, seen_at, message, reason} (ISO 8601 local time with offset;
# reason "usage limit" or "out of credits"). It is
# published whole (temp file in the same dir, then rename), because parallel
# sessions review at once. A record past its resets_at is ignored, and so is
# one that can't be read: a bad record never blocks an account.
#
# bash 3.2 and `set -u` safe. Names are prefixed _cx_ (constants _CX_).
# Test-only: CODEX_SAFE_NOW=<epoch> replaces the clock.

_cx_cfg=""
_cx_conf=""
_cx_limits=""
_cx_err=""
_cx_names=()
_cx_homes=()
_cx_lines=()

# A usage-limit error, or an out-of-credits one: codex-cli
# 0.163.0 prints "ERROR: Your workspace is out of credits. Ask your workspace
# owner to refill in order to continue." and exits 1. It names no reset, so
# its record holds for the 1-hour fallback and the account is tried again
# after that. Either is codex's own error line, anchored at column 0 like the
# reviewers' CLI-error trigger (.claude/agents/plan-reviewer.md, Step 2). The
# caller applies it only to a run that exited non-zero, so a successful run
# whose echoed prompt contains the words never counts. It counts only as the
# LAST non-empty line codex wrote to stderr (a deliberate choice):
# codex prints its real error last before exiting (seen live, twice), while
# the echoed prompt and the file contents codex prints while working come
# earlier. As many copies of a line as the arguments hold are the echo and
# are skipped first, so a run that dies right after echoing a prompt that ends
# in such a line can't fake one either. A future codex that prints after its
# error only loses failover: the review falls back to in-model, as before.
_CX_LIMIT_RE='^(?:ERROR|error)\b.*(?:usage limit|out of credits)'

# One perl program for time and record handling. Modes:
#   detect ARGS ERR          print the last non-empty line of ERR (codex's
#                            stderr), echoed copies of ARGS skipped, if it is
#                            a limit line (usage limit or out of credits)
#   write DIR NAME MSG NOW   publish DIR/NAME.json, print
#                            "<epoch>\t<display>\t<reason>\t<iso>"
#   read FILE NOW            print "<epoch>\t<display>\t<reason>\t<iso>" if the
#                            record is unexpired
# <reason> sits before <iso> so callers that take field 1, field 2 or the last
# field read the same values as before it existed.
#   parse MSG NOW            print "<epoch>\t<iso>" (the reset MSG names)
# shellcheck disable=SC2016 # perl code, expanded by perl
_CX_PL='
use strict;
use warnings;
use POSIX qw(strftime mktime);
use Time::Local qw(timegm);

my %mon = (jan => 0, feb => 1, mar => 2, apr => 3, may => 4, jun => 5,
           jul => 6, aug => 7, sep => 8, oct => 9, nov => 10, dec => 11);

sub iso {
  my ($t) = @_;
  my @l = localtime($t);
  my $off = timegm(@l[0 .. 5]) - $t;
  my $sign = $off < 0 ? "-" : "+";
  $off = abs($off);
  return strftime("%Y-%m-%dT%H:%M:%S", @l)
    . sprintf("%s%02d:%02d", $sign, int($off / 3600), int(($off % 3600) / 60));
}

sub from_iso {
  my ($s) = @_;
  return undef unless defined $s
    && $s =~ /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)([+-])(\d\d):(\d\d)$/;
  my $t = eval { timegm($6, $5, $4, $3, $2 - 1, $1) };
  return undef unless defined $t;
  return $t - ($7 eq "-" ? -1 : 1) * ($8 * 3600 + $9 * 60);
}

# HH:MM when the reset is on the same local day as now, else "Mon DD HH:MM".
sub display {
  my ($t, $now) = @_;
  my @a = localtime($t);
  my @b = localtime($now);
  return strftime("%H:%M", @a) if $a[5] == $b[5] && $a[7] == $b[7];
  return strftime("%b %d %H:%M", @a);
}

# "try again at 3:23 PM": local time today, or tomorrow if that is not after
# now. "try again at Oct 24th, 2026 3:23 PM": that date. Else undef.
sub parse {
  my ($msg, $now) = @_;
  return undef unless $msg =~ /try again at\s+(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4}),?\s+)?(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\b/;
  my ($mn, $d, $y, $h, $mi, $ap) = ($1, $2, $3, $4, $5, lc $6);
  return undef if $h < 1 || $h > 12 || $mi > 59;
  $h = $h % 12;
  $h += 12 if $ap eq "p";
  if (defined $mn) {
    my $m = $mon{lc $mn};
    return undef unless defined $m && $d >= 1 && $d <= 31;
    return mktime(0, $mi, $h, $d, $m, $y - 1900, 0, 0, -1);
  }
  my @n = localtime($now);
  my $t = mktime(0, $mi, $h, $n[3], $n[4], $n[5], 0, 0, -1);
  $t = mktime(0, $mi, $h, $n[3] + 1, $n[4], $n[5], 0, 0, -1) if $t <= $now;
  return $t;
}

# "out of credits" when MSG says so, else "usage limit" (also for old and
# hand-written records).
sub reason {
  my ($msg) = @_;
  return (defined $msg && !ref($msg) && $msg =~ /out of credits/i) ? "out of credits" : "usage limit";
}

sub jstr {
  my ($s) = @_;
  $s =~ s/(["\\])/\\$1/g;
  $s =~ s/([\x00-\x1f])/sprintf("\\u%04x", ord($1))/ge;
  return "\"$s\"";
}

my $mode = shift @ARGV;
if ($mode eq "detect") {
  my $last;
  my %sent;
  my $args = shift @ARGV;
  if (open(my $fh, "<", $args)) {
    while (my $l = <$fh>) { $l =~ s/\r?\n\z//; $sent{$l}++; }
  }
  my $err = shift @ARGV;
  if (open(my $fh, "<", $err)) {
    while (my $l = <$fh>) {
      $l =~ s/\r?\n\z//;
      # Skip only as many copies as were sent (the echo); a further copy of
      # the same line came from codex itself.
      if ($sent{$l}) { $sent{$l}--; next; }
      $last = $l if $l =~ /\S/;
    }
  }
  print "$last\n" if defined $last && $last =~ /'"$_CX_LIMIT_RE"'/i;
  exit 0;
}
if ($mode eq "parse") {
  my ($msg, $now) = @ARGV;
  my $t = parse($msg, $now) // ($now + 3600);
  print "$t\t", iso($t), "\n";
  exit 0;
}
if ($mode eq "write") {
  my ($dir, $name, $msg, $now) = @ARGV;
  $msg = substr($msg, 0, 1000);
  my $t = parse($msg, $now) // ($now + 3600);
  my $body = "{\"resets_at\":" . jstr(iso($t)) . ",\"seen_at\":" . jstr(iso($now))
    . ",\"message\":" . jstr($msg) . ",\"reason\":" . jstr(reason($msg)) . "}\n";
  my $tmp = "$dir/.$name.json.$$.tmp";
  my $old = umask(077);
  open(my $fh, ">", $tmp) or exit 3;
  print $fh $body or exit 3;
  close($fh) or exit 3;
  umask($old);
  rename($tmp, "$dir/$name.json") or do { unlink($tmp); exit 3 };
  print "$t\t", display($t, $now), "\t", reason($msg), "\t", iso($t), "\n";
  exit 0;
}
if ($mode eq "read") {
  my ($file, $now) = @ARGV;
  open(my $fh, "<", $file) or exit 0;
  local $/;
  my $s = <$fh> // "";
  # A real JSON parse: a truncated or malformed record is unreadable, and
  # an unreadable record is ignored, never trusted for its resets_at.
  require JSON::PP;
  my $v = eval { JSON::PP->new->decode($s) };
  exit 0 unless ref($v) eq "HASH" && defined $v->{resets_at} && !ref($v->{resets_at});
  my $t = from_iso($v->{resets_at});
  my $why = $v->{reason};
  $why = reason($v->{message}) unless defined $why && !ref($why)
    && ($why eq "usage limit" || $why eq "out of credits");
  print "$t\t", display($t, $now), "\t$why\t", iso($t), "\n" if defined $t && $t > $now;
  exit 0;
}
exit 2;
'

# perl's startup variables could run code first (as _HA_PERL in bin/harness-account).
_cx_pl() {
  /usr/bin/env -u PERL5OPT -u PERL5LIB -u PERLLIB -u PERL5DB -u PERLIO /usr/bin/perl -e "$_CX_PL" "$@"
}

_cx_now() {
  case ${CODEX_SAFE_NOW:-} in
    '' | *[!0-9]*) /bin/date +%s ;;
    *) printf '%s\n' "$CODEX_SAFE_NOW" ;;
  esac
}

# Sets _cx_cfg, _cx_conf and _cx_limits. Returns 1 when HOME is unusable.
_cx_paths() {
  case ${XDG_CONFIG_HOME:-} in
    /*) _cx_cfg=$XDG_CONFIG_HOME/ai-harness ;;
    *)
      case ${HOME:-} in
        /*) _cx_cfg=$HOME/.config/ai-harness ;;
        *) return 1 ;;
      esac
      ;;
  esac
  _cx_conf=$_cx_cfg/accounts.conf
  _cx_limits=$_cx_cfg/codex-limits
}

# Reads the `codex` lines of accounts.conf (other lines are each parser's own)
# into _cx_names, _cx_homes and _cx_lines. A missing file means no accounts.
# Returns 2 with _cx_err set on a file that can't be read or a bad codex line.
_cx_load() {
  local _cx_line _cx_no=0 _cx_j _cx_phys
  local -a _cx_w _cx_physes=()
  _cx_names=()
  _cx_homes=()
  _cx_lines=()
  _cx_err=""
  [ -e "$_cx_conf" ] || return 0
  if [ ! -f "$_cx_conf" ] || [ ! -r "$_cx_conf" ]; then
    _cx_err="cannot read $_cx_conf"
    return 2
  fi
  while IFS= read -r _cx_line || [ -n "$_cx_line" ]; do
    _cx_no=$((_cx_no + 1))
    _cx_line=${_cx_line%%#*}
    _cx_line=${_cx_line%$'\r'}
    set -f
    # shellcheck disable=SC2206 # deliberate word split; globbing is off
    _cx_w=($_cx_line)
    set +f
    [ "${#_cx_w[@]}" -gt 0 ] && [ "${_cx_w[0]}" = codex ] || continue
    if [ "${#_cx_w[@]}" -ne 3 ] || ! [[ ${_cx_w[1]} =~ ^[a-z0-9-]+$ ]]; then
      _cx_err="$_cx_conf:$_cx_no: expected 'codex <name> <codex_home>'"
      return 2
    fi
    case ${_cx_w[2]} in
      /*) ;;
      *)
        _cx_err="$_cx_conf:$_cx_no: codex home must be an absolute path"
        return 2
        ;;
    esac
    # Two accounts on one CODEX_HOME are one login: "failover" would retry the
    # same limited account under another name. Compared as written and, for
    # a dir that exists, by its physical path (a symlink or another spelling).
    _cx_phys=${_cx_w[2]}
    if [ -d "$_cx_phys" ]; then
      _cx_phys=$(CDPATH='' cd -P -- "$_cx_phys" 2>/dev/null && pwd -P) || _cx_phys=${_cx_w[2]}
    fi
    _cx_j=0
    while [ "$_cx_j" -lt "${#_cx_names[@]}" ]; do
      if [ "${_cx_names[$_cx_j]}" = "${_cx_w[1]}" ]; then
        _cx_err="$_cx_conf:$_cx_no: codex account '${_cx_w[1]}' is already defined on line ${_cx_lines[$_cx_j]}"
        return 2
      fi
      if [ "${_cx_homes[$_cx_j]}" = "${_cx_w[2]}" ] || [ "${_cx_physes[$_cx_j]}" = "$_cx_phys" ]; then
        _cx_err="$_cx_conf:$_cx_no: codex home ${_cx_w[2]} is also the home of '${_cx_names[$_cx_j]}' (line ${_cx_lines[$_cx_j]}); each Codex account needs its own"
        return 2
      fi
      _cx_j=$((_cx_j + 1))
    done
    _cx_names+=("${_cx_w[1]}")
    _cx_homes+=("${_cx_w[2]}")
    _cx_physes+=("$_cx_phys")
    _cx_lines+=("$_cx_no")
  done <"$_cx_conf"
}

# _cx_limit NAME [NOW]: prints "<epoch>\t<display>\t<reason>\t<iso>" when NAME
# has an unexpired limit record, nothing otherwise.
_cx_limit() {
  _cx_pl read "$_cx_limits/$1.json" "${2:-$(_cx_now)}" 2>/dev/null || :
}

# _cx_record NAME MESSAGE [NOW]: writes NAME's limit record; prints
# "<epoch>\t<display>\t<reason>\t<iso>". Returns non-zero if it couldn't be
# written.
_cx_record() {
  if [ ! -d "$_cx_limits" ]; then
    (umask 077 && /bin/mkdir -p -- "$_cx_limits") 2>/dev/null || [ -d "$_cx_limits" ] || return 1
  fi
  _cx_pl write "$_cx_limits" "$1" "$2" "${3:-$(_cx_now)}"
}

# _cx_detect ARGS ERR: prints ERR's last non-empty line (echoed copies of ARGS
# skipped) if it is a limit line.
_cx_detect() {
  _cx_pl detect "$@"
}

# _cx_reason LINE: "out of credits" when codex's limit line says so, else
# "usage limit"; the record's own test, for wording that can't wait on a
# record (one that couldn't be written).
_cx_reason() {
  case $1 in
    *[Oo][Uu][Tt]' '[Oo][Ff]' '[Cc][Rr][Ee][Dd][Ii][Tt][Ss]*) printf 'out of credits\n' ;;
    *) printf 'usage limit\n' ;;
  esac
}
