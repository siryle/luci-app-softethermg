#!/usr/bin/env bash
set -euo pipefail

DIST_DIR="${PWD}/release-assets"
mkdir -p "$DIST_DIR"

python3 - << 'PY_EOF'
import os
import re
import urllib.request
import zipfile
import shutil

DIST_DIR = os.path.abspath("release-assets")
os.makedirs(DIST_DIR, exist_ok=True)

targets = [
    ("aarch64_generic", "aarch64"),
    ("x86_64", "x86_64"),
]

patterns = [
    ("softethervpn-server", r"(?<![\w\-])softethervpn-server-[\w\.\-~]+\.apk"),
    ("softethervpn-base", r"(?<![\w\-])softethervpn-base-[\w\.\-~]+\.apk"),
    ("softethervpn5-server", r"(?<![\w\-])softethervpn5-server-[\w\.\-~]+\.apk"),
    ("softethervpn5-libs", r"(?<![\w\-])softethervpn5-libs-[\w\.\-~]+\.apk"),
    ("curl", r"(?<![\w\-])curl-\d[\w\.\-~]+\.apk"),
    ("libcurl4", r"(?<![\w\-])libcurl4-[\w\.\-~]+\.apk"),
    ("jsonfilter", r"(?<![\w\-])jsonfilter-[\w\.\-~]+\.apk"),
]

for arch, alias in targets:
    print(f"==> Resolving dependencies for OpenWrt {alias} ({arch})...")
    stage_dir = f"/tmp/deps-{alias}"
    shutil.rmtree(stage_dir, ignore_errors=True)
    os.makedirs(stage_dir, exist_ok=True)

    base_url = f"https://downloads.openwrt.org/snapshots/packages/{arch}/base"
    pkgs_url = f"https://downloads.openwrt.org/snapshots/packages/{arch}/packages"

    try:
        base_html = urllib.request.urlopen(f"{base_url}/", timeout=20).read().decode("utf-8", errors="ignore")
        pkgs_html = urllib.request.urlopen(f"{pkgs_url}/", timeout=20).read().decode("utf-8", errors="ignore")
    except Exception as e:
        print(f"    [WARN] Failed to fetch index for {arch}: {e}")
        continue

    downloaded = []
    for name, pat in patterns:
        pool = base_html if name == "jsonfilter" else pkgs_html
        prefix = base_url if name == "jsonfilter" else pkgs_url
        matches = list(dict.fromkeys(re.findall(pat, pool)))
        if not matches:
            print(f"    [WARN] No package found matching {name}")
            continue
        pkg_file = matches[0]
        pkg_url = f"{prefix}/{pkg_file}"
        dest_path = os.path.join(stage_dir, pkg_file)
        print(f"    -> Downloading {pkg_file}...")
        try:
            urllib.request.urlretrieve(pkg_url, dest_path)
            downloaded.append(dest_path)
        except Exception as e:
            print(f"    [ERROR] Download failed for {pkg_file}: {e}")

    # Pack into zip
    zip_path = os.path.join(DIST_DIR, f"dependencies-openwrt-{alias}.zip")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in downloaded:
            zf.write(file_path, arcname=os.path.basename(file_path))
    print(f"==> Successfully created {zip_path} with {len(downloaded)} APK packages.")

PY_EOF
