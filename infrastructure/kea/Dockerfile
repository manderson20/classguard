FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive

# Pinned to the exact Kea version currently deployed. Without an explicit
# version, every image rebuild pulls whatever ISC's kea-2-6 channel has
# published most recently with zero diff to review - exactly the kind of
# silent, unannounced behavior change in something we depend on (Kea's DHCP
# config semantics, allocator behavior, etc.) we want to catch BEFORE it's
# running, not after. Bumping KEA_VERSION is now a deliberate, reviewable
# change; if that exact version ever ages out of the repo, the build fails
# loudly instead of quietly installing something newer.
ARG KEA_VERSION=2.6.5-isc20260313155734

RUN apt-get update && apt-get install -y curl gnupg ca-certificates && \
    curl -1sLf 'https://dl.cloudsmith.io/public/isc/kea-2-6/setup.deb.sh' | bash - && \
    apt-get install -y \
      isc-kea-dhcp4=${KEA_VERSION} \
      isc-kea-dhcp6=${KEA_VERSION} \
      isc-kea-ctrl-agent=${KEA_VERSION} \
      isc-kea-admin=${KEA_VERSION} \
      isc-kea-common=${KEA_VERSION} \
      isc-kea-hooks=${KEA_VERSION} \
      postgresql-client \
      gettext-base \
    && apt-mark hold isc-kea-dhcp4 isc-kea-dhcp6 isc-kea-ctrl-agent isc-kea-admin isc-kea-common isc-kea-hooks \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 67/udp = DHCPv4, 547/udp = DHCPv6, 8000 = Kea Control Agent
EXPOSE 67/udp 547/udp 8000

ENTRYPOINT ["/entrypoint.sh"]
