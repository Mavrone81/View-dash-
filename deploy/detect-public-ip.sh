#!/usr/bin/env bash
# Prints this host's globally-routable IPv4 address on stdout, or fails
# (exit 1, message on stderr) if it cannot determine one. Nothing else ever
# goes to stdout, so a caller can safely do `addr=$(detect-public-ip.sh)`.
#
# WHY THIS IS NOT `hostname -I | awk '{print $1}'`:
#
# `hostname -I` prints every address on every interface, in an order this
# script does not control -- private NIC, docker0, tunnel, WireGuard, and
# the real public address, all mixed together. Taking the FIRST of them, as
# deploy/verify.sh previously did, therefore hands back whichever interface
# the kernel happened to list first. On a host with a private NIC (which is
# most of this estate -- private networking, VPN, and a Docker bridge are
# all normal here) that is a private address.
#
# That matters because verify.sh's two most important checks are "web is
# NOT on the public interface" and "ingest is NOT on the public interface".
# Probing a PRIVATE address and finding nothing there proves nothing about
# what the internet can reach, but it makes both checks report PASS -- the
# exposure check certifies the exact thing it exists to catch. A quiet
# false pass on that question is worse than no check at all, because it is
# believed.
#
# So: filter to addresses that are actually globally routable, and if none
# can be found, FAIL rather than fall back to something plausible-looking.
set -u

# Explicit override, for the case this cannot solve on its own: a host
# behind NAT (a cloud VM with a floating/elastic address, for instance)
# has NO globally-routable address on any of its own interfaces, so no
# amount of interface inspection can find one. That is a real deployment
# shape, and it must be servable by telling the script the answer -- not by
# silently guessing at a private address.
if [ -n "${BEVORA_PUBLIC_IP:-}" ]; then
  printf '%s\n' "$BEVORA_PUBLIC_IP"
  exit 0
fi

if ! command -v ip >/dev/null 2>&1; then
  echo "detect-public-ip.sh: no 'ip' command available to enumerate interfaces; set BEVORA_PUBLIC_IP to this host's public address and re-run" >&2
  exit 1
fi

# `scope global` already removes loopback and link-local; the grep then
# removes the RFC 1918 private ranges and the RFC 3927 link-local range,
# which `scope global` does NOT remove (a private address on a LAN is
# globally scoped as far as the kernel is concerned).
addr="$(
  ip -4 -o addr show scope global 2>/dev/null |
    awk '{print $4}' |
    cut -d/ -f1 |
    grep -Ev '^(10\.|127\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)' |
    head -n1
)"

if [ -z "$addr" ]; then
  echo "detect-public-ip.sh: no globally-routable IPv4 address found on any interface. If this host is behind NAT, set BEVORA_PUBLIC_IP to the address the internet reaches it on and re-run. Refusing to guess: the exposure checks that use this value would otherwise probe the wrong address and PASS without having tested anything." >&2
  exit 1
fi

printf '%s\n' "$addr"
