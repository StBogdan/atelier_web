# Build the cloud app, build the server, and keep only what runs.
#
# The editor is not in here. It is a separate upstream project, patched at build time (see the README,
# "Running the editor from the patched source"), and this image proxies to it wherever it runs. Point
# PHOTOCRAFT_UPSTREAM at it.

FROM node:22-bookworm-slim AS cloud-app
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM rust:1-bookworm AS server
# What the settings page reports as the build's commit, baked in at compile time. Empty when the build
# does not say, and the page then shows unknown.
ARG ATELIER_BUILD_COMMIT=
ENV ATELIER_BUILD_COMMIT=$ATELIER_BUILD_COMMIT
WORKDIR /app
COPY server/Cargo.toml server/Cargo.lock ./
# A stub main, so the dependency build is cached independently of the source that follows.
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release && rm -rf src
COPY server/src ./src
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim
# No TLS stack and no C toolchain to carry: the server speaks HTTP to a local upstream, and the browser
# is what talks HTTPS to the bucket.
RUN useradd --system --create-home --uid 10001 atelier
COPY --from=server /app/target/release/atelier-web-server /usr/local/bin/atelier-web-server
COPY --from=cloud-app /app/web/build /srv/atelier-cloud

USER atelier
# A container has no loopback to share with its host, unlike the default one-origin setup.
ENV ATELIER_BIND=0.0.0.0 \
    ATELIER_PORT=3000 \
    ATELIER_WEB_DIR=/srv/atelier-cloud \
    PHOTOCRAFT_UPSTREAM=http://editor:8080
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/atelier-web-server"]
