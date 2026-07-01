#!/bin/bash
set -e

# Clear stale PID/socket files from a previous crashed run — same reasoning
# as infrastructure/kea/entrypoint.sh: this container's writable layer
# persists across restarts (not recreated), so leftovers can linger.
rm -f /run/charon.vici /run/charon.pid

# The package's default charon-systemd.conf routes all logging to the
# systemd journal only -- a black hole in a plain container with no
# journald running, so `docker logs` would show nothing even once charon
# is running correctly. Override to also log to stderr.
cat > /etc/strongswan.d/charon-systemd.conf <<'EOF'
charon-systemd {
    filelog {
        stderr {
            default = 1
        }
    }
}
EOF

trap 'kill "${CHARON_PID:-}" "${AGENT_PID:-}" 2>/dev/null' TERM INT

# charon (the IKE daemon) starts with zero connections configured — it only
# learns about the staff-vpn connection once vpn-agent.py pushes config to
# it over the vici socket below. Backgrounded so the agent (which also has
# to wait for that socket) can be this container's foreground PID 1.
#
# Binary path: strongSwan's Ubuntu 26.04 packaging dropped the classic
# ipsec-starter-launched `/usr/lib/ipsec/charon` binary entirely -- that
# path now only contains shared libraries (libcharon.so etc.) and helper
# scripts. The daemon itself ships exclusively as the systemd-integrated
# `charon-systemd` at /usr/sbin/. It runs fine standalone outside actual
# systemd as long as it has the capabilities/network_mode this container
# already gets from docker-compose.yml (NET_ADMIN, NET_RAW, host network) --
# confirmed live, it correctly loads all plugins and starts 16 worker
# threads. Missed when 234487b bumped the strongswan version pin for
# 26.04; that commit fixed the package version but not this path.
/usr/sbin/charon-systemd &
CHARON_PID=$!

for _ in $(seq 1 30); do
  [ -S /run/charon.vici ] && break
  sleep 1
done

/vpn-agent.py &
AGENT_PID=$!

# Wait for whichever of the two exits first — if either crashes, the
# container should exit too so `restart: unless-stopped` actually restarts
# the whole pair, rather than silently limping along with just one alive.
wait -n "$CHARON_PID" "$AGENT_PID"
