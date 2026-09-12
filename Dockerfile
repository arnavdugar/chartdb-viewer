# syntax=docker/dockerfile:1

FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /chartdb
ADD --checksum=sha256:8e854d6ac2f65f526be2f748373c9150cce4502cc8c49085cde40fa7a167eb0c https://codeload.github.com/chartdb/chartdb/tar.gz/refs/tags/v1.20.1 /tmp/chartdb.tar.gz
RUN tar -xzf /tmp/chartdb.tar.gz --strip-components=1 -C /chartdb
RUN npm ci
COPY main.tsx src/main.tsx
COPY index.html index.html
COPY .prettierrc.json .prettierrc.json
ENV VITE_DISABLE_ANALYTICS=true VITE_HIDE_CHARTDB_CLOUD=true
RUN NODE_OPTIONS=--max-old-space-size=4096 npm run build

FROM --platform=$BUILDPLATFORM golang:1.27.0-alpine3.24 AS server-build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
ARG TARGETOS
ARG TARGETARCH
RUN go vet ./...
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/chartdb-viewer .

FROM alpine:3.24
WORKDIR /app
ENV ASSETS_DIRECTORY=/app/public SCHEMA_DIRECTORY=/schema
LABEL org.opencontainers.image.source="https://github.com/arnavdugar/chartdb-viewer" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
COPY --from=build /chartdb/dist public/
COPY --from=server-build /out/chartdb-viewer /usr/local/bin/chartdb-viewer
EXPOSE 80
CMD ["chartdb-viewer"]
