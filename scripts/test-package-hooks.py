#!/usr/bin/env python3
"""Check actual package build arguments and install/upgrade ACL refresh hooks."""
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / 'root/usr/share/softethermg/postinst.sh'
GROUP = 'luci-app-softethermg'
OBJECT = 'luci.softethermg'


class PackageHookTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='softethermg-hook-tests-')
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name)
        self.log = self.path / 'events'
        self.env = {**os.environ, 'TEST_LOG': str(self.log), 'IPKG_INSTROOT': ''}

    def install_hook(self, offline=False, reload_fails=False):
        service = self.path / 'etc/init.d/rpcd'
        defaults = self.path / 'etc/uci-defaults/luci-app-softethermg'
        service.parent.mkdir(parents=True, exist_ok=True)
        defaults.parent.mkdir(parents=True, exist_ok=True)
        service.write_text('''#!/bin/sh
printf 'rpcd:%s\\n' "$1" >> "$TEST_LOG"
[ "$1" != reload ] || [ "${TEST_RELOAD_FAIL:-0}" != 1 ]
''')
        defaults.write_text('''#!/bin/sh
printf 'defaults\\n' >> "$TEST_LOG"
''')
        service.chmod(0o755); defaults.chmod(0o755)
        cache = self.path / 'tmp'
        (cache / 'luci-modulecache').mkdir(parents=True)
        for name in ('luci-indexcache', 'luci-indexcache.12345678.json', 'luci-modulecache/module', 'unrelated-file'):
            (cache / name).write_text('cached')
        source = HOOK.read_text().replace('/etc/', str(self.path / 'etc') + '/').replace('/tmp/', str(cache) + '/')
        subprocess.run(['sh', '-c', source], env={**self.env, 'IPKG_INSTROOT': str(self.path / 'image') if offline else '',
                                                'TEST_RELOAD_FAIL': '1' if reload_fails else '0'}, check=True)
        return cache

    def test_live_hook_refreshes_existing_session_acls_and_caches(self):
        cache = self.install_hook()
        self.assertEqual(self.log.read_text().splitlines(), ['defaults', 'rpcd:reload'])
        self.assertFalse((cache / 'luci-indexcache').exists())
        self.assertFalse((cache / 'luci-indexcache.12345678.json').exists())
        self.assertFalse((cache / 'luci-modulecache/module').exists())
        self.assertTrue((cache / 'unrelated-file').exists())

    def test_rpcd_reload_failure_falls_back_to_restart(self):
        self.install_hook(reload_fails=True)
        self.assertEqual(self.log.read_text().splitlines(), ['defaults', 'rpcd:reload', 'rpcd:restart'])

    def test_image_build_does_not_run_host_services_or_clear_caches(self):
        cache = self.install_hook(offline=True)
        self.assertFalse(self.log.exists())
        self.assertTrue((cache / 'luci-indexcache.12345678.json').exists())
        self.assertTrue((cache / 'luci-modulecache/module').exists())

    def test_acl_covers_every_rpc_method_and_menu_requires_the_group(self):
        source = (ROOT / 'root/usr/libexec/rpcd/luci.softethermg').read_text().replace('. /usr/share/softethermg/api.sh', '')
        methods = json.loads(subprocess.check_output(['sh', '-c', source, 'test', 'list'], text=True))
        acl = json.loads((ROOT / 'root/usr/share/rpcd/acl.d/luci-app-softethermg.json').read_text())[GROUP]
        read = set(acl['read']['ubus'][OBJECT]); write = set(acl['write']['ubus'][OBJECT])
        self.assertEqual(read | write, set(methods))
        self.assertFalse(read & write)
        self.assertIn('enum_listeners', read)
        for method in ('set_listener', 'set_server_cert', 'backup_config', 'set_policy'):
            self.assertIn(method, write)
            self.assertNotIn(method, read)
        self.assertNotIn('*', read | write)
        menu = json.loads((ROOT / 'root/usr/share/luci/menu.d/luci-app-softethermg.json').read_text())
        self.assertEqual(menu['admin/services/softethermg']['depends']['acl'], [GROUP])
        self.assertFalse(any(key.startswith('admin/vpn/') for key in menu))

    def test_all_apk_variants_attach_upgrade_hook_and_ipk_uses_same_hook(self):
        # Mock only Docker and apk, execute the real builder to inspect its output.
        workspace = self.path / 'workspace'
        workspace.mkdir()
        shutil.copytree(ROOT / 'root', workspace / 'root')
        shutil.copytree(ROOT / 'htdocs', workspace / 'htdocs')
        (workspace / 'scripts').mkdir()
        shutil.copy2(ROOT / 'scripts/build-packages.sh', workspace / 'scripts/build-packages.sh')
        tools = self.path / 'bin'; tools.mkdir()
        docker = tools / 'docker'
        docker.write_text('''#!/usr/bin/env python3
import subprocess, sys
sys.exit(subprocess.run(['sh','-c',sys.argv[-1]]).returncode)
''')
        apk = tools / 'apk'
        apk.write_text('''#!/usr/bin/env python3
import json, sys
from pathlib import Path
args=sys.argv[1:]
if args[0]=='add': sys.exit(0)
assert args[0]=='mkpkg'
hooks={}
for i,arg in enumerate(args):
 if arg=='--script':
  name,file=args[i+1].split(':',1)
  hooks[name]=Path(file).read_text()
output=Path(args[args.index('--output')+1])
staging=Path(args[args.index('--files')+1])
output.write_text(json.dumps({'hooks':hooks,'acl':json.loads((staging/'usr/share/rpcd/acl.d/luci-app-softethermg.json').read_text())}))
''')
        docker.chmod(0o755); apk.chmod(0o755)
        process = subprocess.run(['bash', 'scripts/build-packages.sh', '99.0.0'], cwd=workspace,
                                 env={**self.env, 'PATH': str(tools) + ':' + os.environ['PATH']}, capture_output=True, text=True)
        self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
        packages = list((workspace / 'release-assets').glob('*.apk'))
        self.assertEqual(len(packages), 4)
        for package in packages:
            artifact = json.loads(package.read_text())
            self.assertEqual(set(artifact['hooks']), {'post-install', 'post-upgrade'})
            self.assertEqual(artifact['hooks']['post-install'], HOOK.read_text())
            self.assertEqual(artifact['hooks']['post-upgrade'], HOOK.read_text())
            self.assertIn('enum_listeners', artifact['acl'][GROUP]['read']['ubus'][OBJECT])
        with tarfile.open(workspace / 'release-assets/luci-app-softethermg_99.0.0-1_all.ipk') as ipk:
            control = ipk.extractfile('control.tar.gz').read()
        with tarfile.open(fileobj=io.BytesIO(control)) as archive:
            self.assertEqual(archive.extractfile('./postinst').read().decode(), HOOK.read_text())
            self.assertTrue(archive.getmember('./postinst').mode & 0o111)


if __name__ == '__main__':
    unittest.main(verbosity=2)
