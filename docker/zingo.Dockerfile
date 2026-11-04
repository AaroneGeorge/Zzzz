# zingo-cli (zingolabs/zingolib, dev branch) built for TESTNET use as Fallback A of ZecRecharge.
# zcli/zecli cannot do testnet (0.6.0 talks a retired zidecar API; 0.10.0 is mainnet-only).
#
# Build:  sudo docker build -f docker/zingo.Dockerfile -t zecrecharge/zingo-cli docker/
# Use:    see scripts/wallet-zingo.sh (wraps `docker run` with a persistent data volume)
#
# We build WITHOUT the Nym mixnet (no nym-proxy to bundle) and WITH `nakednet-test-mode`,
# which lets the CLI go online directly over gRPC to a pinned indexer (--server).
# Privacy trade-off (documented in docs/zcash-leg.md): the indexer sees our IP.
ARG ZINGOLIB_REF=dev

FROM rust:1-bookworm AS build
ARG ZINGOLIB_REF
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential gcc libsqlite3-dev protobuf-compiler pkg-config libssl-dev git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 --branch ${ZINGOLIB_REF} https://github.com/zingolabs/zingolib.git
WORKDIR /src/zingolib
# rust-toolchain.toml pins the toolchain; rustup installs it on first cargo call.
RUN cargo --version && git log -1 --format='zingolib %H %cI' | tee /zingolib.commit
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/zingolib/target \
    cargo build --release -p zingo-cli --no-default-features --features nakednet-test-mode \
    && cp target/release/zingo-cli /usr/local/bin/zingo-cli

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/zingo-cli /usr/local/bin/zingo-cli
COPY --from=build /zingolib.commit /zingolib.commit
WORKDIR /data
ENTRYPOINT ["zingo-cli"]
CMD ["--help"]
