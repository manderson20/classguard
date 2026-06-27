FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive

# Pinned to Ubuntu 26.04's native Kea package version. Without an explicit
# version, every image rebuild pulls whatever Ubuntu has published most
# recently with zero diff to review - exactly the kind of silent behavior
# change in DHCP config semantics, allocator behavior, or database schema
# handling that should fail loudly before it is running.
ARG KEA_VERSION=3.0.3-1

RUN apt-get update && apt-get install -y \
      kea-dhcp4-server=${KEA_VERSION} \
      kea-dhcp6-server=${KEA_VERSION} \
      kea-ctrl-agent=${KEA_VERSION} \
      kea-admin=${KEA_VERSION} \
      kea-common=${KEA_VERSION} \
      postgresql-client \
      gettext-base \
    && apt-mark hold kea-dhcp4-server kea-dhcp6-server kea-ctrl-agent kea-admin kea-common \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 67/udp = DHCPv4, 547/udp = DHCPv6, 8000 = Kea Control Agent
EXPOSE 67/udp 547/udp 8000

ENTRYPOINT ["/entrypoint.sh"]
