/**
 * Bash that defines `flock FD` when the host lacks util-linux, as macOS does.
 * Perl's flock takes the same kernel lock on the shell's open descriptor, and
 * the shell keeps holding it after perl exits, exactly as `flock FD` does.
 */
export const FLOCK_SHIM = `command -v flock >/dev/null || flock() { perl -MFcntl=:flock -e 'open(my $fh, ">&=", $ARGV[0]) or die "fd $ARGV[0]: $!"; flock($fh, LOCK_EX) or die "flock: $!"' "$1"; }`;

/** Bash that defines `timeout SECONDS COMMAND...` when the host lacks coreutils, as macOS does, running the command unbounded. */
export const TIMEOUT_SHIM = `command -v timeout >/dev/null || timeout() { shift; "$@"; }`;
