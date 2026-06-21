#!/bin/bash
set -e

# Clear stale PID/socket files from a previous crashed run — same reasoning
# as infrastructure/kea/entrypoint.sh: this container's writable layer
# persists across restarts (not recreated), so leftovers can linger.
rm -f /run/charon.vici /run/charon.pid

trap 'kill "${CHARON_PID:-}" "${AGENT_PID:-}" 2>/dev/null' TERM INT

# charon (the IKE daemon) starts with zero connections configured — it only
# learns about the staff-vpn connection once vpn-agent.py pushes config to
# it over the vici socket below. Backgrounded so the agent (which also has
# to wait for that socket) can be this container's foreground PID 1.
/usr/lib/ipsec/charon &
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
