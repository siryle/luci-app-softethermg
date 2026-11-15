#!/usr/bin/env python3
"""Offline protocol tests: python3 scripts/test-protocols.py."""
import base64
import csv
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
API = ROOT / 'root/usr/share/softethermg/api.sh'
RPC = ROOT / 'root/usr/libexec/rpcd/luci.softethermg'


def csv_table(rows):
    out = io.StringIO()
    csv.writer(out).writerows([('Item', 'Value'), *rows])
    return out.getvalue()


# Labels and Yes/No values match SoftEtherVPN_Stable's Command.c / English table.
IPSEC = csv_table([
    ('L2TP over IPsec Server Function Enabled', 'No'),
    ('Raw L2TP Server Function Enabled', 'Yes'),
    ('EtherIP / L2TPv3 over IPsec Server Function Enabled', 'Yes'),
    ('IPsec Pre-Shared Key String', 'key,"\\value'),
    ('Name of Default Virtual Hub', 'HUB, "office"'),
])
OPENVPN = csv_table([('OpenVPN Clone Server Enabled', 'Yes'), ('UDP Port List', '1194, 5555, 65535')])
SSTP = csv_table([('SSTP VPN Clone Server Enabled', 'Yes')])

STUBS = '''
get_api_type() { echo "$TEST_ENGINE"; }
get_api_host() { echo 127.0.0.1; }
get_api_port() { echo 5555; }
get_admin_password() { echo test-password; }
find_vpncmd() { echo sh; }
run_vpncmd() {
    printf '%s\\n' "$2" >> "$TEST_LOG"
    case "$2" in
        IPsecGet) printf '%s' "$TEST_IPSEC"; return "${TEST_READ_EXIT:-0}" ;;
        OpenVpnGet) printf '%s' "$TEST_OPENVPN"; return "${TEST_READ_EXIT:-0}" ;;
        SstpGet) printf '%s' "$TEST_SSTP" ;;
        OpenVpnEnable*) return "${TEST_SET_OPENVPN_EXIT:-0}" ;;
        SstpEnable*) return "${TEST_SET_SSTP_EXIT:-0}" ;;
        IPsecEnable*) return "${TEST_SET_IPSEC_EXIT:-0}" ;;
        OpenVpnMakeConfig*)
            target="${2#OpenVpnMakeConfig }"
            printf '%s' "$target" > "$TEST_EXPORT_PATH"
            umask > "$TEST_UMASK"
            [ "${TEST_EXPORT_MODE:-ok}" != fail ] || return 1
            [ "${TEST_EXPORT_MODE:-ok}" != missing ] || return 0
            cp "$TEST_ARCHIVE" "$target"
            ;;
        *) echo 'Unexpected vpncmd invocation' >&2; return 1 ;;
    esac
}
curl() {
    while [ "$#" -gt 0 ]; do
        if [ "$1" = -d ]; then
            printf '%s' "$2" > "$TEST_PAYLOAD"
            shift
        fi
        shift
    done
    printf '%s' "$TEST_RESPONSE"
}
'''


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='softethermg-protocols-')
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name)
        self.archive = self.path / 'source.zip'
        with zipfile.ZipFile(self.archive, 'w') as archive:
            archive.writestr('openvpn_remote_access_l3.ovpn', 'dev tun\n<ca>test certificate</ca>\n')
            archive.writestr('openvpn_site_to_site_bridge_l2.ovpn', 'dev tap\n')
            archive.writestr('readme.txt', 'Generated on the VPN server')
        self.env = {
            **os.environ, 'TEST_ENGINE': 'vpncmd', 'TEST_IPSEC': IPSEC,
            'TEST_OPENVPN': OPENVPN, 'TEST_SSTP': SSTP,
            'TEST_ARCHIVE': str(self.archive), 'TEST_LOG': str(self.path / 'calls'),
            'TEST_EXPORT_PATH': str(self.path / 'export-path'), 'TEST_UMASK': str(self.path / 'umask'),
            'TEST_PAYLOAD': str(self.path / 'payload'), 'TEST_RESPONSE': '{"result":{}}',
        }

    def call(self, command, *args, ok=True, extra='', **env):
        script = f'. {shlex.quote(str(API))}\n{STUBS}\n{extra}\n{command} "$@"'
        process = subprocess.run(['sh', '-c', script, 'test', *args],
                                 env={**self.env, **env}, text=True, capture_output=True)
        self.assertEqual(process.stderr, '')
        self.assertEqual(process.returncode == 0, ok, process.stdout)
        return json.loads(process.stdout)

    def calls(self):
        path = self.path / 'calls'
        return path.read_text().splitlines() if path.exists() else []

    def test_csv_settings_and_escaping(self):
        self.assertEqual(self.call('se_get_ipsec')['result'], {
            'L2TP_IPsec_bool': False, 'L2TP_Raw_bool': True, 'EtherIP_IPsec_bool': True,
            'IPsec_Secret_str': 'key,"\\value', 'L2TP_DefaultHub_str': 'HUB, "office"',
        })
        self.assertEqual(self.call('se_get_openvpn')['result'], {
            'EnableOpenVPN_bool': True, 'EnableSSTP_bool': True,
            'OpenVPNPortList_str': '1194, 5555, 65535',
        })
        disabled = self.call('se_get_openvpn', TEST_OPENVPN=OPENVPN.replace('Yes', 'No'), TEST_SSTP=SSTP.replace('Yes', 'No'))
        self.assertFalse(disabled['result']['EnableOpenVPN_bool'])
        self.assertFalse(disabled['result']['EnableSSTP_bool'])
        value = 'quote" slash\\ tab\t newline\n中文\r\n'
        self.assertEqual(self.call('json_string', value), value)

    def test_reads_report_failure_instead_of_default_settings(self):
        for method in ('se_get_ipsec', 'se_get_openvpn'):
            with self.subTest(method=method):
                self.assertIn('error', self.call(method, ok=False, TEST_READ_EXIT='1'))
                self.assertIn('error', self.call(method, ok=False, TEST_IPSEC='', TEST_OPENVPN=''))

    def test_native_writes_include_all_protocol_flags(self):
        self.call('se_set_ipsec', 'false', 'vpn', 'DEFAULT', 'true', 'true')
        self.call('se_set_openvpn', 'false', '1194, 5555 65535', 'true')
        self.assertEqual(self.calls(), [
            'IPsecEnable /L2TP:no /L2TPRAW:yes /ETHERIP:yes /PSK:vpn /DEFAULTHUB:DEFAULT',
            'OpenVpnEnable no /PORTS:1194,5555,65535', 'SstpEnable yes',
        ])

    def test_native_write_errors_are_not_success(self):
        for env in ({'TEST_SET_OPENVPN_EXIT': '1'}, {'TEST_SET_SSTP_EXIT': '1'}):
            self.assertIn('error', self.call('se_set_openvpn', 'true', '1194', 'true', ok=False, **env))
        self.assertIn('error', self.call('se_set_ipsec', 'true', 'vpn', 'DEFAULT', ok=False, TEST_SET_IPSEC_EXIT='1'))

    def test_invalid_ports_and_cli_option_injection_do_not_reach_server(self):
        for ports in ('0', '65536', '-1', '1194,/PORTS:443', '1194,', 'hello', '1.5'):
            with self.subTest(ports=ports):
                self.assertEqual(self.call('se_set_openvpn', 'true', ports, 'false', ok=False)['error']['code'], -32602)
        self.assertEqual(self.call('se_set_ipsec', 'true', 'vpn /L2TP:no', 'DEFAULT', ok=False)['error']['code'], -32602)
        self.assertEqual(self.calls(), [])

    def test_native_export_zip_integrity_and_cleanup(self):
        result = self.call('se_make_openvpn_config')['result']
        contents = base64.b64decode(result['Buffer_bin'], validate=True)
        self.assertEqual(contents, self.archive.read_bytes())
        with zipfile.ZipFile(io.BytesIO(contents)) as archive:
            self.assertIn('openvpn_remote_access_l3.ovpn', archive.namelist())
            self.assertIn('openvpn_site_to_site_bridge_l2.ovpn', archive.namelist())
        self.assertFalse(Path((self.path / 'export-path').read_text()).parent.exists())
        self.assertEqual(int((self.path / 'umask').read_text().strip(), 8), 0o77)

    def test_native_export_failure_and_cleanup(self):
        for mode in ('fail', 'missing'):
            with self.subTest(mode=mode):
                self.assertIn('error', self.call('se_make_openvpn_config', ok=False, TEST_EXPORT_MODE=mode))
                self.assertFalse(Path((self.path / 'export-path').read_text()).parent.exists())
        self.assertIn('error', self.call('se_make_openvpn_config', ok=False, extra='base64() { return 1; }'))
        self.assertFalse(Path((self.path / 'export-path').read_text()).parent.exists())

    def test_json_rpc_export_payload_and_upstream_errors(self):
        reply = {'result': {'Buffer_bin': base64.b64encode(self.archive.read_bytes()).decode()}}
        self.assertEqual(self.call('se_make_openvpn_config', TEST_ENGINE='rpc', TEST_RESPONSE=json.dumps(reply)), reply)
        payload = json.loads((self.path / 'payload').read_text())
        self.assertEqual(payload['method'], 'MakeOpenVpnConfigFile')
        self.assertEqual(payload['params'], {})
        error = {'error': {'code': 13, 'message': 'OpenVPN is not enabled'}}
        self.assertEqual(self.call('se_make_openvpn_config', TEST_ENGINE='rpc', TEST_RESPONSE=json.dumps(error)), error)
        self.call('rpc_call', 'GetOpenVpnSstpConfig')
        self.assertEqual(json.loads((self.path / 'payload').read_text())['params'], {})

    def test_json_rpc_protocol_writes_preserve_parameters(self):
        self.call('se_set_ipsec', 'true', 'p"\\key\n', '办公室 HUB', 'true', 'true', TEST_ENGINE='rpc')
        payload = json.loads((self.path / 'payload').read_text())
        self.assertEqual(payload['params'], {
            'L2TP_IPsec_bool': True, 'L2TP_Raw_bool': True, 'EtherIP_IPsec_bool': True,
            'IPsec_Secret_str': 'p"\\key\n', 'L2TP_DefaultHub_str': '办公室 HUB',
        })
        self.call('se_set_openvpn', 'true', '1194 5555', 'false', TEST_ENGINE='rpc')
        payload = json.loads((self.path / 'payload').read_text())
        self.assertEqual(payload['params'], {
            'EnableOpenVPN_bool': True, 'OpenVPNPortList_str': '1194,5555', 'EnableSSTP_bool': False,
        })

    def test_export_endpoint_registration_acl_and_dispatch(self):
        source = RPC.read_text().replace('. /usr/share/softethermg/api.sh',
            f'. {shlex.quote(str(API))}\n{STUBS}\nget_config_value() {{ echo 1; }}', 1)
        process = subprocess.run(['sh', '-c', source, 'test', 'call', 'make_openvpn_config'],
                                 env=self.env, text=True, capture_output=True, check=True)
        self.assertIn('Buffer_bin', json.loads(process.stdout)['result'])
        acl = json.loads((ROOT / 'root/usr/share/rpcd/acl.d/luci-app-softethermg.json').read_text())
        acl = acl['luci-app-softethermg']
        self.assertIn('make_openvpn_config', acl['write']['ubus']['luci.softethermg'])
        self.assertNotIn('make_openvpn_config', acl['read']['ubus']['luci.softethermg'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
