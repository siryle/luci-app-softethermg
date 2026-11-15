#!/usr/bin/env python3
"""Offline server-management tests: python3 scripts/test-server.py."""
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
API = (ROOT / 'root/usr/share/softethermg/api.sh').read_text()
RPC = (ROOT / 'root/usr/libexec/rpcd/luci.softethermg').read_text()
CERT = b'-----BEGIN CERTIFICATE-----\nMAMCAQE=\n-----END CERTIFICATE-----\n'
KEY = b'-----BEGIN PRIVATE KEY-----\nMAMCAQI=\n-----END PRIVATE KEY-----\n'
CONFIG = b'declare root\n{\n\tstring Secret confidential\n}\n'

STUBS = '''
get_api_type() { echo "$TEST_ENGINE"; }
get_api_port() { echo "${TEST_PORT:-5555}"; }
get_config_value() { echo 1; }
find_vpncmd() { echo sh; }
uci() { printf '%s\\n' "$*" >> "$TEST_UCI_LOG"; return "${TEST_UCI_EXIT:-0}"; }
run_vpncmd() {
    printf '%s\\n' "$2" >> "$TEST_NATIVE_LOG"
    [ "${2%% *}" != "${TEST_FAIL_COMMAND:-}" ] || return 1
    case "$2" in
        ListenerList) printf '%s' "$TEST_LISTENERS" ;;
        ServerCertGet*|ConfigGet*)
            target="${2#* }"
            printf '%s' "$target" > "$TEST_EXPORT_PATH"
            [ "${TEST_NO_FILE:-0}" != 1 ] || return 0
            if [ "${2%% *}" = ServerCertGet ]; then printf '%s' "$TEST_CERT" > "$target"
            else printf '%s' "$TEST_CONFIG" > "$target"; fi
            ;;
        ServerCertSet*)
            cert="${2#* /LOADCERT:}"; cert="${cert%% /LOADKEY:*}"
            key="${2#* /LOADKEY:}"
            printf '%s' "$key" > "$TEST_EXPORT_PATH"
            cp "$cert" "$TEST_CAPTURE_CERT"; cp "$key" "$TEST_CAPTURE_KEY"
            stat -f '%Lp' "$key" > "$TEST_MODE" 2>/dev/null || stat -c '%a' "$key" > "$TEST_MODE"
            [ "${TEST_IMPORT_FAIL:-0}" != 1 ] || return 1
            ;;
    esac
}
rpc_call() {
    printf '%s\\n%s\\n' "$1" "$2" >> "$TEST_RPC_LOG"
    printf '%s' "$TEST_RESPONSE"
}
'''


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='softethermg-server-test-')
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name)
        parser = self.path / 'jsonfilter'
        parser.write_text('''#!/usr/bin/env python3
import json, sys
try:
    value=json.load(sys.stdin)
    for key in sys.argv[2].removeprefix('@.').split('.'):
        if not isinstance(value,dict) or key not in value: sys.exit(0)
        value=value[key]
    print(json.dumps(value,separators=(',',':')) if not isinstance(value,str) else value)
except ValueError: pass
''')
        parser.chmod(0o755)
        self.env = {**os.environ, 'PATH': str(self.path) + ':' + os.environ['PATH'],
                    'TEST_ENGINE': 'vpncmd', 'TEST_CERT': CERT.decode(), 'TEST_CONFIG': CONFIG.decode(),
                    'TEST_RESPONSE': '{"result":{}}', 'TEST_LISTENERS': 'Port Number,Status\r\nTCP 443,Listening\r\nTCP 992,Stopped\r\nTCP 5555,Error\r\n',
                    **{key: str(self.path / name) for key, name in (
                        ('TEST_NATIVE_LOG', 'native'), ('TEST_RPC_LOG', 'rpc'), ('TEST_EXPORT_PATH', 'export'),
                        ('TEST_CAPTURE_CERT', 'cert'), ('TEST_CAPTURE_KEY', 'key'), ('TEST_MODE', 'mode'), ('TEST_UCI_LOG', 'uci'))}}

    def call(self, method, *args, ok=True, **env):
        process = subprocess.run(['sh', '-c', API + '\n' + STUBS + f'\n{method} "$@"', 'test', *args],
                                 env={**self.env, **env}, capture_output=True, text=True)
        self.assertEqual(process.stderr, '')
        self.assertEqual(process.returncode == 0, ok, process.stdout)
        return json.loads(process.stdout)

    def rpc_calls(self):
        lines = (self.path / 'rpc').read_text().splitlines()
        return [(lines[i], json.loads(lines[i + 1])) for i in range(0, len(lines), 2)]

    def test_listener_read_states_and_parse_errors(self):
        self.assertEqual(self.call('se_enum_listeners')['result']['ListenerList'], [
            {'Ports_u32': 443, 'Enables_bool': True, 'Errors_bool': False},
            {'Ports_u32': 992, 'Enables_bool': False, 'Errors_bool': False},
            {'Ports_u32': 5555, 'Enables_bool': True, 'Errors_bool': True}])
        self.assertEqual(self.call('se_enum_listeners', TEST_LISTENERS='Port Number,Status\n')['result']['ListenerList'], [])
        self.assertIn('error', self.call('se_enum_listeners', TEST_LISTENERS='', ok=False))
        self.assertIn('error', self.call('se_enum_listeners', TEST_FAIL_COMMAND='ListenerList', ok=False))

    def test_listener_validation_and_management_port_protection(self):
        for port in ('0', '65536', '443 /CMD:x', '1.5', '-1', ''):
            self.assertEqual(self.call('se_change_listener', 'create', port, 'true', ok=False)['error']['code'], -32602)
        for action in ('set', 'delete'):
            self.assertIn('current management port', self.call('se_change_listener', action, '05555', 'false', TEST_PORT='05555', ok=False)['error']['message'])
        self.assertFalse((self.path / 'native').exists())
        self.assertFalse((self.path / 'rpc').exists())

    def test_native_listener_writes_and_failure(self):
        for action, port, enabled in [('create', '1194', 'true'), ('set', '443', 'false'), ('set', '443', 'true'), ('delete', '443', 'true')]:
            self.call('se_change_listener', action, port, enabled)
        self.assertEqual((self.path / 'native').read_text().splitlines(), ['ListenerCreate 1194', 'ListenerDisable 443', 'ListenerEnable 443', 'ListenerDelete 443'])
        self.assertIn('error', self.call('se_change_listener', 'create', '1194', 'true', TEST_FAIL_COMMAND='ListenerCreate', ok=False))

    def test_rpc_listener_payloads(self):
        self.call('se_change_listener', 'create', '1194', 'true', TEST_ENGINE='rpc')
        self.call('se_change_listener', 'set', '443', 'false', TEST_ENGINE='rpc')
        self.assertEqual(self.rpc_calls(), [('CreateListener', {'Port_u32': 1194, 'Enable_bool': True}), ('EnableListener', {'Port_u32': 443, 'Enable_bool': False})])

    def test_native_exports_and_cleanup_on_success_missing_file_and_failure(self):
        for method, field, content, command in [('se_get_server_cert', 'Cert_bin', CERT, 'ServerCertGet'), ('se_backup_config', 'FileData_bin', CONFIG, 'ConfigGet')]:
            self.assertEqual(base64.b64decode(self.call(method)['result'][field]), content)
            self.assertFalse(Path((self.path / 'export').read_text()).parent.exists())
            self.assertIn('error', self.call(method, TEST_NO_FILE='1', ok=False))
            self.assertFalse(Path((self.path / 'export').read_text()).parent.exists())
            self.assertIn('error', self.call(method, TEST_FAIL_COMMAND=command, ok=False))

    def test_rpc_certificate_strips_private_key_and_errors(self):
        cert = base64.b64encode(CERT).decode()
        response = json.dumps({'result': {'Cert_bin': cert, 'Key_bin': 'PRIVATE_KEY_MUST_NOT_LEAVE_BACKEND', 'Flag1_u32': 1}})
        self.assertEqual(self.call('se_get_server_cert', TEST_ENGINE='rpc', TEST_RESPONSE=response), {'jsonrpc': '2.0', 'result': {'Cert_bin': cert}, 'id': '1'})
        self.assertIn('error', self.call('se_get_server_cert', TEST_ENGINE='rpc', TEST_RESPONSE='{"result":{}}', ok=False))
        self.assertIn('Permission denied', self.call('se_get_server_cert', TEST_ENGINE='rpc', TEST_RESPONSE='{"error":{"message":"Permission denied"}}', ok=False)['error']['message'])

    def test_certificate_import_private_files_and_cleanup(self):
        cert = base64.b64encode(CERT).decode(); key = base64.b64encode(KEY).decode()
        for fail in ('0', '1'):
            reply = self.call('se_set_server_cert', cert, key, TEST_IMPORT_FAIL=fail, ok=fail == '0')
            self.assertIn('error' if fail == '1' else 'result', reply)
            self.assertEqual((self.path / 'cert').read_bytes(), CERT)
            self.assertEqual((self.path / 'key').read_bytes(), KEY)
            self.assertEqual(int((self.path / 'mode').read_text().strip(), 8), 0o600)
            self.assertFalse(Path((self.path / 'export').read_text()).parent.exists())
        self.assertIn('error', self.call('se_set_server_cert', 'bad;input', key, ok=False))
        self.assertIn('error', self.call('se_set_server_cert', 'A', key, ok=False))
        large = 'se_set_server_cert "$(awk \'BEGIN { for (i = 0; i < 131076; i++) printf "A" }\')"'
        self.assertIn('error', self.call(large, key, ok=False))

    def test_rpc_certificate_import_never_echoes_private_key(self):
        cert = base64.b64encode(CERT).decode(); key = base64.b64encode(KEY).decode()
        reply = self.call('se_set_server_cert', cert, key, TEST_ENGINE='rpc', TEST_RESPONSE=json.dumps({'result': {'Cert_bin': cert, 'Key_bin': key}}))
        self.assertEqual(reply['result'], {})
        self.assertEqual(self.rpc_calls(), [('SetServerCert', {'Cert_bin': cert, 'Key_bin': key})])
        self.assertIn('error', self.call('se_set_server_cert', cert, key, TEST_ENGINE='rpc', TEST_RESPONSE='{}', ok=False))

    def test_regeneration_validation_payload_and_backup(self):
        self.call('se_regenerate_server_cert', 'vpn.example', TEST_ENGINE='rpc')
        self.assertEqual(self.rpc_calls()[-1], ('RegenerateServerCert', {'StrValue_str': 'vpn.example'}))
        for name in ('', 'vpn.example /CMD:bad', 'x\nrestart'):
            self.assertIn('error', self.call('se_regenerate_server_cert', name, ok=False))
        encoded = base64.b64encode(CONFIG).decode()
        self.assertEqual(self.call('se_backup_config', TEST_ENGINE='rpc', TEST_RESPONSE=json.dumps({'result': {'FileData_bin': encoded}}))['result']['FileData_bin'], encoded)

    def test_password_change_failure_never_updates_local_credential(self):
        source = RPC.replace('. /usr/share/softethermg/api.sh', API + '\n' + STUBS, 1)
        for response in ('{"error":{"message":"Denied"}}', '{}', '{"result":null}'):
            process = subprocess.run(['sh', '-c', source, 'test', 'call', 'change_admin_password'],
                                     input='{"password":"new password"}\n', env={**self.env, 'TEST_ENGINE': 'rpc', 'TEST_RESPONSE': response}, capture_output=True, text=True)
            self.assertIn('error', json.loads(process.stdout))
            self.assertFalse((self.path / 'uci').exists())
        process = subprocess.run(['sh', '-c', source, 'test', 'call', 'change_admin_password'], input='{"password":"new password"}\n',
                                 env={**self.env, 'TEST_ENGINE': 'rpc'}, capture_output=True, text=True, check=True)
        self.assertIn('result', json.loads(process.stdout))
        self.assertEqual((self.path / 'uci').read_text().splitlines(), ['set softethermg.global.admin_password=new password', 'commit softethermg'])

    def test_rpc_upload_reads_payload_from_stdin(self):
        capture = self.path / 'curl.json'
        executable = self.path / 'curl'
        executable.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
pathlib.Path(os.environ['TEST_CURL_CAPTURE']).write_text(json.dumps({'args':sys.argv[1:],'body':sys.stdin.read()}))
print('{"result":{}}')
''')
        executable.chmod(0o755)
        payload = json.dumps({'Cert_bin': 'public-certificate', 'Key_bin': 'private-key-body-must-not-be-an-argument'})
        script = API + '''
get_api_host() { echo 127.0.0.1; }
get_api_port() { echo 5555; }
get_admin_password() { echo test-password; }
rpc_call "$@"
'''
        for hub in ('', 'OFFICE'):
            subprocess.run(['sh', '-c', script, 'test', 'SetServerCert', payload, hub],
                           env={**self.env, 'TEST_CURL_CAPTURE': str(capture)}, capture_output=True, text=True, check=True)
            recorded = json.loads(capture.read_text())
            self.assertEqual(recorded['args'][recorded['args'].index('-d') + 1], '@-')
            self.assertNotIn('private-key-body-must-not-be-an-argument', ' '.join(recorded['args']))
            self.assertEqual(json.loads(recorded['body'])['params'], json.loads(payload))

    def test_server_acl_and_menu(self):
        acl=json.loads((ROOT/'root/usr/share/rpcd/acl.d/luci-app-softethermg.json').read_text())['luci-app-softethermg']
        for method in ('set_server_cert', 'regenerate_server_cert', 'backup_config', 'create_listener', 'set_listener', 'delete_listener'):
            self.assertIn(method, acl['write']['ubus']['luci.softethermg'])
            self.assertNotIn(method, acl['read']['ubus']['luci.softethermg'])
        self.assertIn('get_server_cert', acl['read']['ubus']['luci.softethermg'])
        menu=json.loads((ROOT/'root/usr/share/luci/menu.d/luci-app-softethermg.json').read_text())
        self.assertEqual(menu['admin/services/softethermg/server']['action']['path'], 'softethermg/server')
        self.assertTrue(all(key.startswith('admin/services/') for key in menu))


if __name__ == '__main__':
    unittest.main(verbosity=2)
