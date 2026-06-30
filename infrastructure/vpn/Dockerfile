FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive

# Pinned to the exact version available on ubuntu 26.04 at build time.
# strongswan 6.0.4 is a major-version bump from 5.9.5 (22.04) but the
# swanctl config format is unchanged — existing tunnel configs work as-is.
ARG STRONGSWAN_VERSION=6.0.4-1ubuntu3.1

RUN apt-get update && apt-get install -y \
      strongswan=${STRONGSWAN_VERSION} \
      strongswan-swanctl=${STRONGSWAN_VERSION} \
      libstrongswan=${STRONGSWAN_VERSION} \
      libcharon-extra-plugins=${STRONGSWAN_VERSION} \
      iptables \
      python3 \
      curl \
      ca-certificates \
    && apt-mark hold strongswan strongswan-swanctl libstrongswan libcharon-extra-plugins \
    && rm -rf /var/lib/apt/lists/*

COPY vpn-agent.py     /vpn-agent.py
COPY entrypoint.sh    /entrypoint.sh
RUN chmod +x /entrypoint.sh /vpn-agent.py

# Meaningful only for documentation purposes — this container runs with
# network_mode: host (IKEv2/ESP need direct access to the host's real
# interfaces and routing table to correctly handle the VRRP VIP and forward
# decrypted tunnel traffic into the LAN; Docker's bridge network NATs all of
# that away), so these aren't actually published by Compose.
EXPOSE 500/udp 4500/udp 9999

ENTRYPOINT ["/entrypoint.sh"]
