#!/usr/bin/env python3
"""Run with python3 scripts/test-enable-switch.py; no router or VPN service needed."""
import json
import os
from pathlib import Path
import re
import shlex
import subprocess

ROOT = Path(__file__).resolve().parents[1]
RPC = (ROOT / "root/usr/libexec/rpcd/luci.softethermg").read_text()
API = ROOT / "root/usr/share/softethermg/api.sh"
INIT = ROOT / "root/etc/init.d/softethermg"


def run(script, *args, **env):
    result = subprocess.run(
        ["sh", "-c", script, "test", *args],
        env={**os.environ, **env}, capture_output=True, text=True, check=True,
    )
    assert not result.stderr, result.stderr
    return result.stdout.strip()


# Use the real config helper; any unexpected backend call or UCI write fails.
stubs = """
uci() {
    [ "$*" = '-q get softethermg.global.enabled' ] || {
        echo 'Unexpected UCI access' >&2; exit 1;
    }
    printf '%s' "$TEST_ENABLED"
}
"""
for function in set(re.findall(r"\bse_[a-z_]+\b", RPC)):
    stubs += f"{function}() {{ echo 'Unexpected backend call' >&2; exit 1; }}\n"
stubs += "se_enum_hubs() { echo '{\"result\":{\"HubList\":[]}}'; }\n"
script = RPC.replace(
    ". /usr/share/softethermg/api.sh", f". {shlex.quote(str(API))}\n{stubs}", 1,
)
methods = json.loads(run(script, "list", TEST_ENABLED="0"))
for method in methods:
    response = json.loads(run(script, "call", method, TEST_ENABLED="0"))
    assert response["error"]["code"] == -32002, (method, response)
for enabled in ("1", ""):
    response = json.loads(run(script, "call", "enum_hubs", TEST_ENABLED=enabled))
    assert response == {"result": {"HubList": []}}, response

# Exercise startup and reload without touching any real processes.
service_script = f". {shlex.quote(str(INIT))}\n" + """
config_load() { :; }
config_get_bool() {
    case "$3" in
        enabled) eval "$1=$TEST_ENABLED" ;;
        manage_service) eval "$1=$TEST_MANAGE" ;;
    esac
}
logger() { :; }
pgrep() { return "$TEST_NO_PROCESS"; }
find_vpnserver() { PROG=/mock/vpnserver; }
procd_open_instance() { echo open; }
procd_set_param() { echo "param:$*"; }
procd_close_instance() { echo close; }
stop() { echo stop; }
start() { echo start; start_service; }
"""
for enabled, managed, no_process, should_spawn in (
    ("0", "0", "1", False),
    ("0", "1", "1", False),
    ("1", "0", "1", False),
    ("1", "1", "0", False),
    ("1", "1", "1", True),
):
    env = dict(TEST_ENABLED=enabled, TEST_MANAGE=managed, TEST_NO_PROCESS=no_process)
    output = run(service_script + "start_service", **env)
    assert ("param:command /mock/vpnserver execsvc" in output) == should_spawn, output
    output = run(service_script + "reload_service", **env)
    assert output.splitlines()[:2] == ["stop", "start"], output
    assert ("param:command /mock/vpnserver execsvc" in output) == should_spawn, output

print(f"Passed: {len(methods)} disabled RPC methods, enabled/default access, and service startup/reload in both modes.")
