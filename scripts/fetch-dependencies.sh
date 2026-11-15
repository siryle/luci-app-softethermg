#!/usr/bin/env bash
set -euo pipefail

DIST_DIR="${PWD}/release-assets"
mkdir -p "$DIST_DIR"

download_packages_for_arch() {
	local arch="$1"
	local alias="$2"
	local target_dir="/tmp/deps-${alias}"
	rm -rf "$target_dir"
	mkdir -p "$target_dir"

	echo "==> Fetching OpenWrt APK dependencies for ${alias} (${arch})..."

	local base_url="https://downloads.openwrt.org/snapshots/packages/${arch}/base"
	local pkgs_url="https://downloads.openwrt.org/snapshots/packages/${arch}/packages"

	local base_html pkgs_html
	base_html=$(curl -sL "${base_url}/")
	pkgs_html=$(curl -sL "${pkgs_url}/")

	download_item() {
		local html="$1"
		local url_prefix="$2"
		local pattern="$3"
		local filename
		filename=$(echo "$html" | grep -o -E "href=\"${pattern}[^\"]+\.apk\"" | sed "s/href=\"//;s/\"//" | head -n 1 || true)
		if [ -n "$filename" ]; then
			echo "    -> Downloading ${filename}..."
			curl -sL "${url_prefix}/${filename}" -o "${target_dir}/${filename}"
		else
			echo "    [WARN] No match found for: ${pattern}"
		fi
	}

	download_item "$pkgs_html" "$pkgs_url" "softethervpn-server-"
	download_item "$pkgs_html" "$pkgs_url" "softethervpn-base-"
	download_item "$pkgs_html" "$pkgs_url" "softethervpn5-server-"
	download_item "$pkgs_html" "$pkgs_url" "softethervpn5-libs-"
	download_item "$pkgs_html" "$pkgs_url" "curl-[0-9]"
	download_item "$pkgs_html" "$pkgs_url" "libcurl4-"
	download_item "$base_html" "$base_url" "jsonfilter-"
	download_item "$base_html" "$base_url" "jshn-"
	download_item "$base_html" "$base_url" "libjson-c[0-9]*-"
	download_item "$base_html" "$base_url" "libblobmsg-json[0-9]*-"

	local zip_file="${DIST_DIR}/dependencies-openwrt-${alias}.zip"
	(
		cd "$target_dir"
		zip -r -q "$zip_file" ./*
	)
	echo "==> Successfully packed ${zip_file} ($(du -h "$zip_file" | cut -f1))"
	rm -rf "$target_dir"
}

download_packages_for_arch "aarch64_generic" "aarch64"
download_packages_for_arch "x86_64" "x86_64"
