#!/bin/sh
set -e
cd "$(dirname "$0")"
rustup target add wasm32-unknown-unknown 2>/dev/null || true
cargo build --release --target wasm32-unknown-unknown
mkdir -p pkg
cp target/wasm32-unknown-unknown/release/momus_syn_wasm.wasm pkg/momus-syn-wasm.wasm
echo "built pkg/momus-syn-wasm.wasm"
