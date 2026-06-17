FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y curl gnupg ca-certificates && \
    curl -1sLf 'https://dl.cloudsmith.io/public/isc/kea-2-6/setup.deb.sh' | bash - && \
    apt-get install -y \
      isc-kea-dhcp4 \
      isc-kea-ctrl-agent \
      isc-kea-admin \
      postgresql-client \
      gettext-base \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 67/udp = DHCP, 8000 = Kea Control Agent
EXPOSE 67/udp 8000

ENTRYPOINT ["/entrypoint.sh"]
