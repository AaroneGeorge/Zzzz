#!/usr/bin/env bash
# Run zingo-cli (Docker image zecrecharge/zingo-cli, built from docker/zingo.Dockerfile)
# against Zcash TESTNET, with a persistent wallet dir in app/.secrets/zingo-testnet.
#
#   scripts/wallet-zingo.sh addresses
#   scripts/wallet-zingo.sh --nosync balance
#   printf "sync status\nquit\n" | scripts/wallet-zingo.sh      # REPL over stdin (what src/wallet/zingo.ts does)
#   NOTE: `--waitsync <cmd>` hangs in this zingo-cli build; use the REPL instead.
#
# First run creates the wallet: if ZINGO_SEED is unset it is read from
# app/.secrets/zcash_mnemonic.txt and restored at ZINGO_BIRTHDAY (default below).
# Session options must come before the command. Env:
#   ZINGO_SERVER  (default https://testnet.zec.rocks:443; zaino.testnet.unsafe.zec.rocks answered 503 on 2026-11-04)
#   ZINGO_DATA_DIR, ZINGO_IMAGE, ZINGO_BIRTHDAY, DOCKER ("sudo -n docker" or "docker")
set -euo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${ZINGO_DATA_DIR:-$APP/.secrets/zingo-testnet}"
SERVER="${ZINGO_SERVER:-https://testnet.zec.rocks:443}"
IMAGE="${ZINGO_IMAGE:-zecrecharge/zingo-cli}"
BIRTHDAY="${ZINGO_BIRTHDAY:-4581000}"
if [ -z "${DOCKER:-}" ]; then
  if docker info >/dev/null 2>&1; then DOCKER="docker"; else DOCKER="sudo -n --preserve-env=ZINGO_SEED,RUST_LOG docker"; fi
fi
# Preflight (5 s cap): fail fast instead of hanging when Docker or the image is missing.
# shellcheck disable=SC2086
if ! timeout 5 $DOCKER image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "error: Docker image $IMAGE not available via '$DOCKER' (Docker down or image not built)." >&2
  echo "       build it: docker build -f docker/zingo.Dockerfile -t $IMAGE docker/   (or use ZEC_WALLET=mock)" >&2
  exit 3
fi
mkdir -p "$DATA"; chmod 700 "$DATA"

restore=()
if ! ls "$DATA"/*.dat "$DATA"/wallets/*.dat >/dev/null 2>&1 && [ -z "$(ls -A "$DATA" 2>/dev/null | grep -v '^\.' || true)" ]; then
  if [ -z "${ZINGO_SEED:-}" ] && [ -f "$APP/.secrets/zcash_mnemonic.txt" ]; then
    ZINGO_SEED="$(cat "$APP/.secrets/zcash_mnemonic.txt")"
  fi
  if [ -n "${ZINGO_SEED:-}" ]; then restore=(--birthday "$BIRTHDAY"); export ZINGO_SEED; fi
fi

envargs=(-e HOME=/data)
[ -n "${ZINGO_SEED:-}" ] && envargs+=(-e ZINGO_SEED)
[ -n "${RUST_LOG:-}" ] && envargs+=(-e RUST_LOG)

# shellcheck disable=SC2086
exec $DOCKER run -i --rm --network host --user "$(id -u):$(id -g)" "${envargs[@]}" \
  -v "$DATA":/data "$IMAGE" \
  --chain testnet --data-dir /data --server "$SERVER" "${restore[@]}" "$@"
