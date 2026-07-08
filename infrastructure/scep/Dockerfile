# Built from source, pinned to an exact tagged release — same supply-chain
# discipline as infrastructure/kea and infrastructure/vpn (KEA_VERSION,
# STRONGSWAN_VERSION): a reviewable, deliberate version bump rather than
# silently picking up whatever the upstream project's default branch (or a
# random third-party prebuilt Docker Hub image) happens to contain on a
# rebuild — worth being especially deliberate here given this container
# touches ClassGuard's own private CA key.
#
# Built from source rather than downloading the project's own prebuilt
# release zips: no checksums are published for those, whereas building from
# a pinned git tag gets Go's module checksum verification (go.sum) for
# every transitive dependency for free.
FROM golang:1.27rc2-alpine AS build

ARG SCEP_VERSION=v2.3.0
RUN apk add --no-cache git
RUN git clone --branch ${SCEP_VERSION} --depth 1 https://github.com/micromdm/scep.git /src
WORKDIR /src
RUN CGO_ENABLED=0 go build -ldflags "-X main.version=${SCEP_VERSION}" -o /scepserver ./cmd/scepserver

FROM alpine:3

RUN apk add --no-cache curl jq

COPY --from=build /scepserver /usr/bin/scepserver
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
