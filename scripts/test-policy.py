#!/usr/bin/env python3
"""Policy tests with the real OpenWrt jshn helper and a stateful mock VPN server."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
API = (ROOT / 'root/usr/share/softethermg/api.sh').read_text()
MODULE = (ROOT / 'root/usr/share/softethermg/policy.sh').read_text()
SCHEMA = json.loads((ROOT / 'root/usr/share/softethermg/policy.json').read_text())['fields']
JSHN = Path(os.environ['SOFTETHERMG_TEST_JSHN_DIR'])

BACKEND = r'''#!/usr/bin/env python3
import csv, json, os, shlex, sys
from pathlib import Path
path=Path(os.environ['TEST_STATE'])
state=json.loads(path.read_text())
def save(): path.write_text(json.dumps(state))
def record(kind,name): return state['users' if kind=='User' else 'groups'][name]
def emit_csv(rows): csv.writer(sys.stdout,lineterminator='\n').writerows(rows)
def command(text):
    parts=shlex.split(text); method=parts[0]; name=parts[1]; kind='User' if method.startswith('User') else 'Group'
    state['calls'].append([method,name,text]); save()
    item=record(kind,name)
    if method.endswith('Get'):
        if state.get('bad_output'): print('unexpected output'); return 0
        rows=[['Item','Value'],['User Name' if kind=='User' else 'Group Name',name],['Description',item.get('Note_utf','')]]
        if kind=='User' and item.get('GroupName_str'): rows.append(['Group Name',item['GroupName_str']])
        emit_csv(rows)
        if item['UsePolicy_bool']:
            print(); print('Security policy'); emit_csv([['Policy name','Simple description of policy','Setting value']])
            for key,spec in state['schema'].items():
                wire='policy:'+key+'_'+spec['type']
                if wire not in item: continue
                value=item[wire]
                display=('Yes' if value else 'No') if spec['type']=='bool' else '-' if value==0 else str(value)+(' bps' if key in ('MaxUpload','MaxDownload') else ' seconds' if key in ('TimeOut','AutoDisconnect') else '')
                emit_csv([[key,'Description, '+key,display]])
            for wire,value in item.items():
                if wire.startswith('policy:') and wire!='policy:Ver3_bool' and wire.split(':',1)[1].rsplit('_',1)[0] not in state['schema']:
                    key=wire.split(':',1)[1].rsplit('_',1)[0]
                    emit_csv([[key,'Future policy','Yes' if value is True else 'No' if value is False else str(value)]])
        if kind=='Group': print('\nMembers\n name,with,commas\n')
        return 0
    if method.endswith('PolicyRemove'):
        item['UsePolicy_bool']=False; save(); return 0
    key=next(arg[6:] for arg in parts if arg.startswith('/NAME:'))
    value=next(arg[7:] for arg in parts if arg.startswith('/VALUE:'))
    if key==state.get('fail_key'): return 1
    if key==state.get('ignore_key'): return 0
    if not item['UsePolicy_bool']:
        item.update({'policy:'+k+'_'+v['type']:v['default'] for k,v in state['schema'].items()})
        item['UsePolicy_bool']=True
    item['policy:'+key+'_'+state['schema'][key]['type']]=bool(int(value)) if state['schema'][key]['type']=='bool' else int(value)
    save(); return 0
mode=sys.argv[1]
if mode=='batch':
    state['command_file']=sys.argv[2]; state['command_mode']=Path(sys.argv[2]).stat().st_mode&0o777; save()
    code=0
    for line in Path(sys.argv[2]).read_text().splitlines(): code=command(line)
    sys.exit(code)
if mode=='native': sys.exit(command(sys.argv[2]))
method=sys.argv[2]; params=json.loads(sys.argv[3]); state['calls'].append([method,params]); save()
if state.get('rpc_error'): print(json.dumps({'error':{'message':'Permission denied'}})); sys.exit(0)
kind='User' if method.endswith('User') else 'Group'; name=params['Name_str']
if method.startswith('Get'):
    item=dict(record(kind,name))
    if not item['UsePolicy_bool']:
        item={k:v for k,v in item.items() if not k.startswith('policy:')}
        if state.get('omit_disabled_flag'): item.pop('UsePolicy_bool')
    print(json.dumps({'result':item}))
else:
    record(kind,name).clear(); record(kind,name).update(params); save()
    print(json.dumps({'result':dict(record(kind,name))}))
'''
STUBS = '''
get_api_type() { echo "$TEST_ENGINE"; }
find_vpncmd() { echo bash; }
get_config_value() { echo 1; }
run_vpncmd() { "$TEST_BACKEND" native "$2"; }
run_vpncmd_file() { "$TEST_BACKEND" batch "$2"; }
rpc_call() { "$TEST_BACKEND" rpc "$1" "$2"; }
'''


def policy_values(**changes):
    values = {'policy:' + name + '_' + spec['type']: spec['default'] for name, spec in SCHEMA.items()}
    for key, value in changes.items(): values['policy:' + key + '_' + SCHEMA[key]['type']] = value
    values['policy:Ver3_bool'] = True
    return values


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='softethermg-policy-tests-')
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name)
        parser=self.path/'jsonfilter'
        parser.write_text('''#!/usr/bin/env python3
import json,sys
try:
 value=json.load(sys.stdin)
 for key in sys.argv[2].removeprefix('@.').split('.'):
  if not isinstance(value,dict) or key not in value: sys.exit(0)
  value=value[key]
 print(json.dumps(value,ensure_ascii=False) if not isinstance(value,str) else value)
except ValueError: pass
''')
        parser.chmod(0o755)
        (self.path/'backend').write_text(BACKEND); (self.path/'backend').chmod(0o755)
        self.record={'HubName_str':'DEFAULT','Name_str':'alice','GroupName_str':'staff','Realname_utf':'Original',
                     'Note_utf':'Original note','AuthType_u32':1,'HashedKey_bin':'private-auth-hash','NtLmSecureHash_bin':'private-nt-hash',
                     'ExpireTime_dt':'2030-01-02T03:04:05.000Z','UsePolicy_bool':False,'Recv.UnicastBytes_u64':9007199254740993}
        self.state={'schema':SCHEMA,'calls':[],'users':{'alice':dict(self.record)},'groups':{'staff':{
            'HubName_str':'DEFAULT','Name_str':'staff','Realname_utf':'Staff','Note_utf':'Group note','UsePolicy_bool':True,
            **policy_values(NoBridge=True,MaxDownload=5000000)}}}
        self.persist()
        module=MODULE.replace('/usr/share/libubox/jshn.sh',shlex.quote(str(JSHN/'jshn.sh'))).replace('/usr/share/softethermg/policy.json',shlex.quote(str(ROOT/'root/usr/share/softethermg/policy.json')))
        (self.path/'policy.sh').write_text(module)
        self.source=API.replace('/usr/share/libubox/jshn.sh',shlex.quote(str(JSHN/'jshn.sh'))).replace('/usr/share/softethermg/policy.sh',shlex.quote(str(self.path/'policy.sh')))
        self.env={**os.environ,'PATH':f'{self.path}:{JSHN}:'+os.environ['PATH'],'TEST_ENGINE':'rpc',
                  'TEST_STATE':str(self.path/'state.json'),'TEST_BACKEND':str(self.path/'backend')}

    def persist(self): (self.path/'state.json').write_text(json.dumps(self.state))
    def actual(self): return json.loads((self.path/'state.json').read_text())

    def call(self, method, *args, ok=True, engine='rpc'):
        process=subprocess.run(['bash','-c',self.source+'\n'+STUBS+f'\n{method} "$@"','test',*args],env={**self.env,'TEST_ENGINE':engine},text=True,capture_output=True)
        self.assertEqual(process.stderr,'')
        self.assertEqual(process.returncode==0,ok,process.stdout)
        return json.loads(process.stdout)

    def test_catalog_matches_softether_ranges_and_defaults(self):
        self.assertEqual(len(SCHEMA),38)
        self.assertEqual(SCHEMA['MaxConnection']['default'],32)
        self.assertEqual((SCHEMA['TimeOut']['min'],SCHEMA['TimeOut']['max']),(5,60))
        self.assertEqual(SCHEMA['MaxUpload']['max'],4294967295)
        self.assertEqual(SCHEMA['VLanId']['max'],4095)
        self.assertTrue(SCHEMA['Access']['default'])
        self.assertTrue(all(spec['type'] in ('bool','u32') and spec['label'] and spec['help'] for spec in SCHEMA.values()))

    def test_read_inheritance_and_never_return_authentication(self):
        for engine in ('rpc','vpncmd'):
            result=self.call('se_get_policy','user','DEFAULT','alice',engine=engine)['result']
            self.assertFalse(result['enabled']); self.assertEqual(result['source'],'group')
            self.assertEqual(result['group'],'staff'); self.assertTrue(result['values']['NoBridge'])
            self.assertEqual(result['values']['MaxDownload'],5000000)
            self.assertEqual(len(result['supported']),38)
            self.assertNotIn('private-auth-hash',json.dumps(result))
            self.assertNotIn('AuthType_u32',json.dumps(result))
        self.state['groups']['staff']['UsePolicy_bool']=False; self.persist()
        result=self.call('se_get_policy','user','DEFAULT','alice')['result']
        self.assertEqual(result['source'],'default'); self.assertTrue(result['values']['Access'])
        self.assertEqual(result['values']['MaxConnection'],32)
        self.state['omit_disabled_flag']=True; self.persist()
        inherited=self.call('se_get_policy','user','DEFAULT','alice')['result']
        self.assertFalse(inherited['enabled']); self.assertEqual(inherited['source'],'default')

    def test_rpc_new_policy_copies_group_and_preserves_account(self):
        self.state['groups']['staff']['policy:FutureFlag_bool']=True; self.persist()
        self.call('se_set_policy','user','DEFAULT','alice','true','{"MaxUpload":4294967295}')
        actual=self.actual()['users']['alice']
        self.assertTrue(actual['UsePolicy_bool'])
        self.assertTrue(actual['policy:NoBridge_bool'])
        self.assertEqual(actual['policy:MaxDownload_u32'],5000000)
        self.assertEqual(actual['policy:MaxUpload_u32'],4294967295)
        self.assertTrue(actual['policy:FutureFlag_bool'])
        for key,value in self.record.items():
            if key!='UsePolicy_bool': self.assertEqual(actual[key],value,key)

    def test_rpc_patch_and_disable_preserve_other_fields(self):
        self.state['users']['alice'].update(policy_values(MaxUpload=123,NoBridge=True))
        self.state['users']['alice'].update(UsePolicy_bool=True)
        self.state['users']['alice']['policy:FutureFlag_bool']=True; self.persist()
        before=dict(self.state['users']['alice'])
        self.call('se_set_policy','user','DEFAULT','alice','true','{"NoBridge":false}')
        actual=self.actual()['users']['alice']
        for key,value in before.items(): self.assertEqual(actual[key],False if key=='policy:NoBridge_bool' else value,key)
        self.call('se_set_policy','user','DEFAULT','alice','false','{}')
        actual=self.actual()['users']['alice']; self.assertFalse(actual['UsePolicy_bool'])
        for key,value in self.record.items():
            if key!='UsePolicy_bool': self.assertEqual(actual[key],value,key)
        inherited=self.call('se_get_policy','user','DEFAULT','alice')['result']
        self.assertTrue(inherited['values']['NoBridge']); self.assertEqual(inherited['source'],'group')

    def test_group_policy_edit_and_remove_in_both_engines(self):
        for engine in ('rpc','vpncmd'):
            self.persist()
            self.call('se_set_policy','group','DEFAULT','staff','true','{"PrivacyFilter":true,"MultiLogins":2}',engine=engine)
            actual=self.actual()['groups']['staff']
            self.assertTrue(actual['policy:PrivacyFilter_bool']); self.assertEqual(actual['policy:MultiLogins_u32'],2)
            self.assertTrue(actual['policy:NoBridge_bool']); self.assertEqual(actual['Note_utf'],'Group note')
            self.call('se_set_policy','group','DEFAULT','staff','false','{}',engine=engine)
            self.assertFalse(self.actual()['groups']['staff']['UsePolicy_bool'])

    def test_invalid_patch_never_writes(self):
        for patch in ('{"Access":1}','{"MaxUpload":-1}','{"MaxDownload":4294967296}','{"TimeOut":0}','{"MaxConnection":33}',
                      '{"MaxMac":65536}','{"VLanId":4096}','{"MaxIP":1.5}','{"AuthType_u32":0}','{"HashedKey_bin":"x"}','{"__proto__":true}','[]','not-json'):
            self.persist()
            self.assertIn('error',self.call('se_set_policy','user','DEFAULT','alice','true',patch,ok=False))
            self.assertFalse(any(call[0].startswith('Set') or 'PolicySet' in call[0] for call in self.actual()['calls']),patch)
        self.assertIn('error',self.call('se_set_policy','user','DEFAULT','alice','false','{"Access":false}',ok=False))

    def test_native_materializes_inherited_values_before_allowing_access(self):
        self.call('se_set_policy','user','DEFAULT','alice','true','{"MaxUpload":4294967295}',engine='vpncmd')
        actual=self.actual(); user=actual['users']['alice']
        self.assertTrue(user['policy:NoBridge_bool']); self.assertEqual(user['policy:MaxDownload_u32'],5000000)
        self.assertEqual(user['policy:MaxUpload_u32'],4294967295); self.assertTrue(user['policy:Access_bool'])
        writes=[call[2] for call in actual['calls'] if 'PolicySet' in call[0]]
        self.assertEqual(writes[0],'UserPolicySet alice /NAME:Access /VALUE:0')
        self.assertEqual(writes[-1],'UserPolicySet alice /NAME:Access /VALUE:1')
        self.assertEqual(actual['command_mode'],0o600)
        self.assertFalse(Path(actual['command_file']).parent.exists())
        result=self.call('se_get_policy','user','DEFAULT','alice',engine='vpncmd')['result']
        self.assertEqual(result['values']['MaxUpload'],4294967295)

    def test_native_partial_failure_never_grants_new_access(self):
        for flag in ('fail_key','ignore_key'):
            self.state[flag]='NoBridge'; self.persist()
            self.assertIn('error',self.call('se_set_policy','user','DEFAULT','alice','true','{"VLanId":100}',engine='vpncmd',ok=False))
            actual=self.actual(); user=actual['users']['alice']
            self.assertTrue(user['UsePolicy_bool']); self.assertFalse(user['policy:Access_bool'])
            self.assertFalse(any('Access /VALUE:1' in call[-1] for call in actual['calls']))
            self.assertFalse(Path(actual['command_file']).parent.exists())
            del self.state[flag]

    def test_native_csv_notes_cannot_forge_inheritance_or_policy(self):
        self.state['users']['alice']['Note_utf']='Group Name,wrong\nPolicy name,description,Setting value\nAccess,description,No'; self.persist()
        result=self.call('se_get_policy','user','DEFAULT','alice',engine='vpncmd')['result']
        self.assertFalse(result['enabled']); self.assertEqual(result['group'],'staff')
        self.assertTrue(result['values']['NoBridge'])
        self.state['bad_output']=True; self.persist()
        self.assertIn('error',self.call('se_get_policy','user','DEFAULT','alice',engine='vpncmd',ok=False))

    def test_unsupported_fields_and_authentication_guards(self):
        del self.state['groups']['staff']['policy:RAFilter_bool']; self.persist()
        result=self.call('se_get_policy','user','DEFAULT','alice')['result']
        self.assertNotIn('RAFilter',result['supported'])
        self.assertIn('error',self.call('se_set_policy','user','DEFAULT','alice','true','{"RAFilter":true}',ok=False))
        del self.state['users']['alice']['HashedKey_bin']; self.persist()
        self.assertIn('error',self.call('se_set_policy','user','DEFAULT','alice','true','{"MaxUpload":100}',ok=False))
        self.assertFalse(any(call[0].startswith('Set') for call in self.actual()['calls']))

    def test_native_refuses_to_drop_unknown_inherited_fields(self):
        self.state['groups']['staff']['policy:FutureFlag_bool']=True; self.persist()
        self.assertIn('error',self.call('se_set_policy','user','DEFAULT','alice','true','{"MaxUpload":100}',engine='vpncmd',ok=False))
        self.assertFalse(any('PolicySet' in call[0] for call in self.actual()['calls']))
        self.assertFalse(self.actual()['users']['alice']['UsePolicy_bool'])

    def test_policy_rpc_dispatch_and_default_patch(self):
        source=(ROOT/'root/usr/libexec/rpcd/luci.softethermg').read_text().replace('. /usr/share/softethermg/api.sh',self.source+'\n'+STUBS,1)
        request={'kind':'user','hub':'DEFAULT','name':'alice','enabled':True,'values':json.dumps({'MultiLogins':2})}
        process=subprocess.run(['bash','-c',source,'test','call','set_policy'],env=self.env,input=json.dumps(request)+'\n',text=True,capture_output=True,check=True)
        self.assertIn('result',json.loads(process.stdout)); self.assertEqual(process.stderr,'')
        self.assertEqual(self.actual()['users']['alice']['policy:MultiLogins_u32'],2)
        request={'kind':'user','hub':'DEFAULT','name':'alice','enabled':False}
        process=subprocess.run(['bash','-c',source,'test','call','set_policy'],env=self.env,input=json.dumps(request)+'\n',text=True,capture_output=True,check=True)
        self.assertIn('result',json.loads(process.stdout)); self.assertFalse(self.actual()['users']['alice']['UsePolicy_bool'])

    def test_policy_acl_and_subject_validation(self):
        for kind in ('server','User',''):
            self.assertIn('error',self.call('se_get_policy',kind,'DEFAULT','alice',ok=False))
        self.assertIn('error',self.call('se_set_policy','user','DEFAULT','alice','yes','{}',ok=False))
        acl=json.loads((ROOT/'root/usr/share/rpcd/acl.d/luci-app-softethermg.json').read_text())['luci-app-softethermg']
        self.assertIn('get_policy',acl['read']['ubus']['luci.softethermg'])
        self.assertIn('set_policy',acl['write']['ubus']['luci.softethermg'])
        self.assertNotIn('set_policy',acl['read']['ubus']['luci.softethermg'])


if __name__=='__main__': unittest.main(verbosity=2)
