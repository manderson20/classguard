FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Pinned to the exact version available on jammy-updates at build time, same
# reasoning as infrastructure/kea/Dockerfile's KEA_VERSION pin — IKEv2/IPsec
# semantics changing out from under us on a routine rebuild is exactly the
# kind of silent behavior change this whole pinning convention exists to
# catch before it's running, not after.
ARG STRONGSWAN_VERSION=5.9.5-2ubuntu2.7

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
