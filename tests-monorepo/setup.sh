#!/usr/bin/env bash
# Recreate symlinks needed for the monorepo fixture.
# node_modules is gitignored, so links must be rebuilt after fresh checkout.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p node_modules/@ws

if [ ! -L node_modules/@rbxts ]; then
	ln -s ../../tests/node_modules/@rbxts node_modules/@rbxts
fi

if [ ! -L node_modules/@ws/leaf ]; then
	ln -s ../../packages/leaf node_modules/@ws/leaf
fi

echo "tests-monorepo: symlinks ready."
