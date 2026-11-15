#!/usr/bin/env python3
"""Account tests using OpenWrt jshn. Set SOFTETHERMG_TEST_JSHN_DIR from prepare-json-tests.sh."""
import csv
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
API = (ROOT / 'root/usr/share/softethermg/api.sh').read_text()
RPC = (ROOT / 'root/usr/libexec/rpcd/luci.softethermg').read_text()
JSHN = Path(os.environ['SOFTETHERMG_TEST_JSHN_DIR'])


def csv_data(rows):
    output = io.StringIO()
    csv.writer(output).writerows(rows)
    return output.getvalue()


USER_HEADER = ['User Name', 'Full Name', 'Group Name', 'Description', 'Auth Method', 'Num Logins', 'Last Login', 'Expires', 'Transfer Bytes', 'Transfer Packets']
GROUP_HEADER = ['Group Name', 'Full Name', 'Description', 'Num Users']
USER_CSV = csv_data([USER_HEADER, ['alice', 'Full, "Name"', 'staff', 'note\nsecond line', 'Password Authentication', '12', '-', '-', '1,234', '10'], ['bob', '', '-', '', 'RADIUS Authentication', '0', '-', '-', '0', '0']])
GROUP_CSV = csv_data([GROUP_HEADER, ['staff', 'Office, Team', 'Members "only"', '2'], ['empty', '', '', '0']])
STUBS = '''
get_api_type() { echo "$TEST_ENGINE"; }
find_vpncmd() { echo bash; }
get_config_value() { echo 1; }
run_vpncmd() {
    printf '%s\\n' "$2" >> "$TEST_CALLS"
    [ "${TEST_FAIL_COMMAND:-}" != "${2%% *}" ] || return 1
    case "$2" in
        UserList) printf '%s' "$TEST_USERS" ;;
        GroupList) printf '%s' "$TEST_GROUPS" ;;
    esac
}
rpc_call() {
    printf '%s\\n%s\\n' "$1" "$2" >> "$TEST_RPC_LOG"
    case "$1" in
        GetUser|GetGroup) printf '%s' "$TEST_RECORD" ;;
        *) printf '%s' "$TEST_RESPONSE" ;;
    esac
}
'''


class AccountTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='softethermg-account-tests-')
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name)
        parser = self.path / 'jsonfilter'
        parser.write_text('''#!/usr/bin/env python3
import json, sys
value = json.load(sys.stdin)
for key in sys.argv[2].removeprefix('@.').split('.'):
    if not isinstance(value, dict) or key not in value:
        sys.exit(0)
    value = value[key]
print(json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value)
''')
        parser.chmod(0o755)
        self.record = {
            'HubName_str': 'DEFAULT', 'Name_str': 'alice', 'GroupName_str': 'staff',
            'Realname_utf': 'Original name', 'Note_utf': 'Original note', 'AuthType_u32': 1,
            'HashedKey_bin': 'existing-hash', 'NtLmSecureHash_bin': 'existing-nt-hash',
            'ExpireTime_dt': '2030-01-02T03:04:05.000Z', 'UsePolicy_bool': True,
            'policy:Access_bool': True, 'policy:MaxDownload_u32': 12345,
            'policy:NoBridge_bool': True, 'policy:MultiLogins_u32': 3,
            'Recv.UnicastBytes_u64': 9007199254740993,
        }
        self.env = {
            **os.environ, 'PATH': f'{self.path}:{JSHN}:' + os.environ['PATH'],
            'TEST_ENGINE': 'vpncmd', 'TEST_USERS': USER_CSV, 'TEST_GROUPS': GROUP_CSV,
            'TEST_CALLS': str(self.path / 'calls'), 'TEST_RPC_LOG': str(self.path / 'rpc'),
            'TEST_RECORD': json.dumps({'result': self.record}), 'TEST_RESPONSE': '{"result":{}}',
        }
        self.source = API.replace('/usr/share/libubox/jshn.sh', str(JSHN / 'jshn.sh'))

    def call(self, method, *args, ok=True, **env):
        process = subprocess.run(['bash', '-c', self.source + '\n' + STUBS + f'\n{method} "$@"', 'test', *args],
                                 env={**self.env, **env}, capture_output=True, text=True)
        self.assertEqual(process.stderr, '')
        self.assertEqual(process.returncode == 0, ok, process.stdout)
        return json.loads(process.stdout)

    def rpc_calls(self):
        lines = (self.path / 'rpc').read_text().splitlines()
        return [(lines[i], json.loads(lines[i + 1])) for i in range(0, len(lines), 2)]

    def test_native_lists_preserve_every_account_and_auth_type(self):
        users = self.call('se_enum_users', 'DEFAULT')['result']['UserList']
        self.assertEqual(len(users), 2)
        self.assertEqual(users[0], {'Name_str': 'alice', 'Realname_utf': 'Full, "Name"', 'GroupName_str': 'staff',
                                  'Note_utf': 'note\nsecond line', 'AuthType_u32': 1, 'NumLogin_u32': 12, 'TrafficBytes_u64': 1234})
        self.assertEqual(users[1]['AuthType_u32'], 4)
        self.assertEqual(users[1]['GroupName_str'], '')
        groups = self.call('se_enum_groups', 'DEFAULT')['result']['GroupList']
        self.assertEqual(groups[0], {'Name_str': 'staff', 'Realname_utf': 'Office, Team', 'Note_utf': 'Members "only"', 'NumUsers_u32': 2})
        self.assertEqual(len(groups), 2)
        older = csv_data([USER_HEADER[:7], ['legacy', '', '-', '', 'Password Authentication', '2', '-']])
        self.assertEqual(self.call('se_enum_users', 'DEFAULT', TEST_USERS=older)['result']['UserList'][0]['Name_str'], 'legacy')

    def test_empty_lists_and_failed_reads_are_distinct(self):
        self.assertEqual(self.call('se_enum_users', 'DEFAULT', TEST_USERS=csv_data([USER_HEADER]))['result']['UserList'], [])
        self.assertIn('error', self.call('se_enum_users', 'DEFAULT', TEST_USERS='', ok=False))
        self.assertIn('error', self.call('se_enum_groups', 'DEFAULT', TEST_FAIL_COMMAND='GroupList', ok=False))
        self.assertIn('error', self.call('se_enum_users', 'DEFAULT', TEST_USERS='"unterminated', ok=False))

    def test_json_create_uses_password_auth_and_access_policy(self):
        self.call('se_create_user', 'DEFAULT', 'alice', 'secret"\\value', '姓名', 'A, "note"', '', '08', '2000', '2', 'staff', TEST_ENGINE='rpc')
        method, payload = self.rpc_calls()[0]
        self.assertEqual(method, 'CreateUser')
        self.assertEqual(payload['AuthType_u32'], 1)
        self.assertEqual(payload['Auth_Password_str'], 'secret"\\value')
        self.assertEqual(payload['GroupName_str'], 'staff')
        self.assertEqual(payload['Note_utf'], 'A, "note"')
        self.assertEqual(payload['policy:MaxUpload_u32'], 8)
        self.assertTrue(payload['UsePolicy_bool'])
        self.assertTrue(payload['policy:Access_bool'])
        self.assertEqual(payload['policy:MaxConnection_u32'], 32)
        self.assertEqual(payload['policy:TimeOut_u32'], 20)
        self.assertTrue(payload['policy:Ver3_bool'])

    def test_invalid_limits_and_option_injection_do_not_write(self):
        for value in ('-1', 'abc', '2147483648', '99999999999999999999999999999'):
            self.assertEqual(self.call('se_create_user', 'DEFAULT', 'alice', 'secret', '', '', '', value, '0', '0', ok=False)['error']['code'], -32602)
        self.assertIn('error', self.call('se_set_user_info', 'DEFAULT', 'alice /GROUP:admin', '', '', '', ok=False))
        self.assertFalse((self.path / 'calls').exists())
        self.assertFalse((self.path / 'rpc').exists())

    def test_native_creates_assigns_group_and_reports_partial_failure(self):
        self.call('se_create_user', 'DEFAULT', 'alice', 'pass "word"', 'Full Name', 'a,b', '', '100', '200', '2', 'staff')
        calls = (self.path / 'calls').read_text().splitlines()
        self.assertIn('UserCreate alice /GROUP:staff /REALNAME:"Full Name" /NOTE:"a,b"', calls)
        self.assertIn('UserPasswordSet alice /PASSWORD:"pass ""word"""', calls)
        self.assertIn('UserPolicySet alice /NAME:MaxUpload /VALUE:100', calls)
        reply = self.call('se_create_user', 'DEFAULT', 'newuser', 'secret', '', '', '', '0', '0', '0', ok=False, TEST_FAIL_COMMAND='UserPasswordSet')
        self.assertIn('created', reply['error']['message'])
        self.assertIn('error', self.call('se_delete_user', 'DEFAULT', 'alice', TEST_FAIL_COMMAND='UserDelete', ok=False))

    def test_password_reset_preserves_metadata_expiry_and_all_policies(self):
        self.call('se_set_user_password', 'DEFAULT', 'alice', 'new-secret', TEST_ENGINE='rpc')
        calls = self.rpc_calls()
        self.assertEqual([method for method, _ in calls], ['GetUser', 'SetUser'])
        payload = calls[-1][1]
        for key, value in self.record.items():
            if key not in ('HashedKey_bin', 'NtLmSecureHash_bin'):
                self.assertEqual(payload[key], value, key)
        self.assertEqual(payload['HashedKey_bin'], '')
        self.assertEqual(payload['NtLmSecureHash_bin'], '')
        self.assertEqual(payload['Auth_Password_str'], 'new-secret')

    def test_editing_user_group_preserves_authentication_and_policy(self):
        for auth in (1, 2, 3, 4, 5):
            record = {**self.record, 'AuthType_u32': auth, 'UserX_bin': 'existing-certificate'}
            self.call('se_set_user_info', 'DEFAULT', 'alice', '新姓名', 'New "note"', '', TEST_ENGINE='rpc', TEST_RECORD=json.dumps({'result': record}))
            payload = self.rpc_calls()[-1][1]
            for key, value in record.items():
                if key not in ('GroupName_str', 'Realname_utf', 'Note_utf'):
                    self.assertEqual(payload[key], value, key)
            self.assertEqual(payload['GroupName_str'], '')
            self.assertEqual(payload['Realname_utf'], '新姓名')

    def test_group_edit_keeps_existing_security_policy(self):
        self.call('se_save_group', 'DEFAULT', 'staff', 'Updated', 'Note', 'false', TEST_ENGINE='rpc', TEST_RECORD=json.dumps({'result': {**self.record, 'Name_str': 'staff'}}))
        calls = self.rpc_calls()
        self.assertEqual([method for method, _ in calls], ['GetGroup', 'SetGroup'])
        self.assertEqual(calls[-1][1]['policy:NoBridge_bool'], True)
        self.assertEqual(calls[-1][1]['policy:MultiLogins_u32'], 3)
        self.call('se_save_group', 'DEFAULT', 'newgroup', 'Name', 'Note', 'true', TEST_ENGINE='rpc')
        self.assertEqual(self.rpc_calls()[-1], ('CreateGroup', {'HubName_str': 'DEFAULT', 'Name_str': 'newgroup', 'Realname_utf': 'Name', 'Note_utf': 'Note', 'UsePolicy_bool': False}))

    def test_failed_get_never_overwrites_accounts(self):
        for method, args in [('se_set_user_password', ('DEFAULT', 'alice', 'secret')), ('se_save_group', ('DEFAULT', 'staff', '', '', 'false'))]:
            reply = self.call(method, *args, TEST_ENGINE='rpc', TEST_RECORD='{"error":{"code":13,"message":"Permission denied"}}', ok=False)
            self.assertEqual(reply['error']['message'], 'Permission denied')
        self.assertFalse(any(method.startswith('Set') for method, _ in self.rpc_calls()))
        incomplete = [{}, {**self.record, 'Name_str': 'different'}]
        for field in ('HashedKey_bin', 'AuthType_u32'):
            incomplete.append({key: value for key, value in self.record.items() if key != field})
        for record in incomplete:
            reply = self.call('se_set_user_info', 'DEFAULT', 'alice', 'Name', 'Note', 'staff', TEST_ENGINE='rpc', TEST_RECORD=json.dumps({'result': record}), ok=False)
            self.assertIn('error', reply)
        self.assertFalse(any(method.startswith('Set') for method, _ in self.rpc_calls()))

    def test_command_files_preserve_quoting_permissions_and_exit_status(self):
        executable = self.path / 'vpncmd'
        capture = self.path / 'invocation.json'
        executable.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
script = pathlib.Path(next(arg[4:] for arg in sys.argv if arg.startswith('/IN:')))
pathlib.Path(os.environ['TEST_CAPTURE']).write_text(json.dumps({
    'argv': sys.argv[1:], 'path': str(script), 'mode': script.stat().st_mode & 0o777,
    'command': script.read_text(),
}))
print('{"result":{}}')
sys.exit(int(os.environ.get('TEST_EXEC_EXIT', '0')))
''')
        executable.chmod(0o755)
        overrides = '''
find_vpncmd() { printf '%s' "$TEST_BINARY"; }
get_api_host() { echo 127.0.0.1; }
get_api_port() { echo 5555; }
get_admin_password() { printf '%s' 'admin  pass"word'; }
run_vpncmd "$@"
'''
        command = 'UserPasswordSet alice /PASSWORD:" pass  ""word"" "'
        env = {**self.env, 'TEST_CAPTURE': str(capture), 'TEST_BINARY': str(executable)}
        for code in ('0', '7'):
            process = subprocess.run(['bash', '-c', self.source + '\n' + overrides, 'test', 'DEFAULT', command],
                                     env={**env, 'TEST_EXEC_EXIT': code}, text=True, capture_output=True)
            self.assertEqual(process.returncode, int(code), process.stderr)
            invocation = json.loads(capture.read_text())
            self.assertEqual(invocation['command'], command + '\n')
            self.assertEqual(invocation['mode'], 0o600)
            self.assertIn('/PASSWORD:admin  pass"word', invocation['argv'])
            self.assertIn('/HUB:DEFAULT', invocation['argv'])
            self.assertFalse(Path(invocation['path']).exists())
        capture.unlink()
        process = subprocess.run(['bash', '-c', self.source + '\n' + overrides, 'test', 'DEFAULT', command + '\nGroupDelete staff'],
                                 env=env, text=True, capture_output=True)
        self.assertNotEqual(process.returncode, 0)
        self.assertFalse(capture.exists())

    def test_dispatch_group_membership_and_acl(self):
        source = RPC.replace('. /usr/share/softethermg/api.sh', self.source + '\n' + STUBS, 1)
        request = {'hub': 'DEFAULT', 'username': 'alice', 'realname': 'Name', 'note': 'Note', 'group': 'staff'}
        process = subprocess.run(['bash', '-c', source, 'test', 'call', 'set_user_info'], env=self.env, input=json.dumps(request) + '\n', capture_output=True, text=True, check=True)
        self.assertIn('result', json.loads(process.stdout))
        self.assertIn('UserSet alice /GROUP:staff', (self.path / 'calls').read_text())
        acl = json.loads((ROOT / 'root/usr/share/rpcd/acl.d/luci-app-softethermg.json').read_text())['luci-app-softethermg']
        self.assertIn('enum_groups', acl['read']['ubus']['luci.softethermg'])
        for method in ('create_group', 'set_group', 'delete_group', 'set_user_info'):
            self.assertIn(method, acl['write']['ubus']['luci.softethermg'])
            self.assertNotIn(method, acl['read']['ubus']['luci.softethermg'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
