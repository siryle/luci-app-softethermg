#!/usr/bin/env bash
# Build OpenWrt's actual JSON helper for account preservation tests on a host.
set -euo pipefail
revision=a396f38a8568a1d670c240465cd8d24fdfdf6463
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/softethermg-json-tests.XXXXXX")
mkdir -p "$test_dir/source"
curl -fsSL --retry 2 "https://codeload.github.com/openwrt/libubox/tar.gz/$revision" | tar -xz --strip-components=1 -C "$test_dir/source"
if command -v pkg-config >/dev/null 2>&1 && pkg-config --exists json-c; then
	read -r -a json_flags <<< "$(pkg-config --cflags --libs json-c)"
elif [ -d /opt/homebrew/opt/json-c ]; then
	json_flags=(-I/opt/homebrew/opt/json-c/include/json-c -L/opt/homebrew/opt/json-c/lib -ljson-c)
else
	echo 'Install the json-c development library to run these host tests.' >&2
	exit 1
fi
sources=()
for name in jshn avl blob blobmsg blobmsg_json utils; do sources+=("$test_dir/source/$name.c"); done
cc -D_GNU_SOURCE -iquote "$test_dir/source" -o "$test_dir/jshn" "${sources[@]}" "${json_flags[@]}"
cp "$test_dir/source/sh/jshn.sh" "$test_dir/jshn.sh"
printf '%s\n' "$test_dir"
