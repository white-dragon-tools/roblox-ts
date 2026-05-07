#!/usr/bin/env bash
# Recreate symlinks needed for the monorepo fixture.
# node_modules is gitignored, so links must be rebuilt after fresh checkout.
set -euo pipefail
cd "$(dirname "$0")"

ensure_link() {
	local target="$1"
	local link_path="$2"
	mkdir -p "$(dirname "$link_path")"
	if [ -L "$link_path" ]; then
		if [ ! -e "$link_path" ] || [ "$(readlink "$link_path")" != "$target" ]; then
			rm "$link_path"
			ln -s "$target" "$link_path"
		fi
	elif [ -e "$link_path" ]; then
		echo "Refusing to replace non-symlink $link_path" >&2
		exit 1
	else
		ln -s "$target" "$link_path"
	fi
}

ensure_link ../../tests/node_modules/@rbxts node_modules/@rbxts
ensure_link ../../packages/leaf node_modules/@ws/leaf

echo "tests-monorepo: symlinks ready."
