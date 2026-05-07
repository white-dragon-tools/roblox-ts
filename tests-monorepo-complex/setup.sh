#!/usr/bin/env bash
# Recreate symlinks needed for the complex monorepo fixture.
# node_modules is gitignored, so links must be rebuilt after fresh checkout.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p node_modules/@complex

if [ ! -L node_modules/@rbxts ]; then
	ln -s ../../tests/node_modules/@rbxts node_modules/@rbxts
fi

if [ ! -L node_modules/@complex/json-leaf ]; then
	ln -s ../../packages/json-leaf node_modules/@complex/json-leaf
fi

echo "tests-monorepo-complex: symlinks ready."
