# ---- Stage 1: build a static-ish release binary ----
# Pinned: `rust:1-bookworm` floats across every 1.x release, so a new
# compiler could break the build with no source change.
FROM rust:1.90-bookworm AS build
WORKDIR /app

# Cache dependency compilation: build against a stub main, then the real source.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs \
    && cargo build --release --locked \
    && rm -rf src
COPY src ./src
# Embedded at compile time by sqlx::migrate! for the accounts database.
COPY migrations ./migrations
# Bust the stub's cached fingerprint so the real binary is rebuilt.
RUN touch src/main.rs && cargo build --release --locked

# ---- Stage 2: minimal runtime ----
# Digest-free but explicit: bookworm-slim is a rolling tag, so rebuild
# deliberately to pick up base-image CVE fixes (ffmpeg included -- it is
# the component that parses untrusted input).
FROM debian:bookworm-slim
# ca-certificates: TLS for the YouTube oEmbed lookup + fetching source streams.
# curl: container healthcheck.
# ffmpeg: the on-the-fly HLS mux/transcode engine spawned per room (see src/stream.rs).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 app \
    # Accounts database home; a named volume mounts here and inherits this
    # ownership on first creation (the server runs as uid 10001).
    && mkdir -p /data && chown app /data

COPY --from=build /app/target/release/watchsync-server /usr/local/bin/watchsync-server

USER app
ENV HOST=0.0.0.0 \
    PORT=3000 \
    RUST_LOG=info \
    DATABASE_PATH=/data/watchsync.db
EXPOSE 3000
CMD ["watchsync-server"]
