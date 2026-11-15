'use strict';
// node scripts/test-users-ui.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const client = new Function('baseclass', '_', fs.readFileSync('htdocs/luci-static/resources/view/softethermg/client.js', 'utf8'))({ extend: value => value }, value => value);
const source = fs.readFileSync('htdocs/luci-static/resources/view/softethermg/users.js', 'utf8');
String.prototype.format ??= function(value) { return this.replace('%s', value); };

function text(node) { return typeof node === 'string' ? node : (node.children || []).map(text).join(''); }
function flatten(nodes) { return nodes.flatMap(node => typeof node === 'string' ? [] : [node, ...flatten(node.children || [])]); }
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

async function setup(hubs = ['DEFAULT', 'OFFICE']) {
	const state = {
		users: [{ Name_str: 'alice', AuthType_u32: 1, GroupName_str: 'staff', Realname_utf: 'Alice', Note_utf: 'Note', NumLogin_u32: 3 }, { Name_str: 'radius', AuthType_u32: 4, Realname_utf: '', Note_utf: '' }],
		groups: [{ Name_str: 'staff', Realname_utf: 'Staff', Note_utf: '', NumUsers_u32: 1 }]
	};
	const calls = [], notices = [], downloads = [], blobs = [];
	const overrides = {};
	let modal = [];
	function E(tag, attrs = {}, children = []) {
		const node = {
			tag, ...attrs, children: (Array.isArray(children) ? children : [children]).filter(value => value != null),
			setAttribute(key, value) { this[key] = value; },
			addEventListener(event, callback) { this[event] = callback; },
			replaceChildren(...values) { this.children = values; },
			appendChild(child) { this.children.push(child); }, remove() {}
		};
		if (tag === 'input') { node.value = String(attrs.value ?? ''); node.checked = !!attrs.checked; }
		if (tag === 'select') node.value = node.children.find(child => child.selected)?.value ?? node.children[0]?.value ?? '';
		if (tag === 'a') node.click = () => downloads.push(node.download);
		return node;
	}
	const handlers = {
		enum_hubs: () => ({ result: { HubList: hubs.map(HubName_str => ({ HubName_str })) } }),
		enum_users: () => ({ result: { UserList: structuredClone(state.users) } }),
		enum_groups: () => ({ result: { GroupList: structuredClone(state.groups) } }),
		set_user_info: (hub, name, realname, note, group) => { Object.assign(state.users.find(user => user.Name_str === name), { Realname_utf: realname, Note_utf: note, GroupName_str: group }); return { result: {} }; },
		add_user: (hub, name, password, realname, note, expires, up, down, logins, group) => { state.users.push({ Name_str: name, AuthType_u32: 1, Realname_utf: realname, Note_utf: note, GroupName_str: group }); return { result: {} }; },
		create_group: (hub, name, realname, note) => { state.groups.push({ Name_str: name, Realname_utf: realname, Note_utf: note, NumUsers_u32: 0 }); return { result: {} }; },
		set_group: (hub, name, realname, note) => { Object.assign(state.groups.find(group => group.Name_str === name), { Realname_utf: realname, Note_utf: note }); return { result: {} }; },
		delete_group: (hub, name) => { state.groups = state.groups.filter(group => group.Name_str !== name); return { result: {} }; },
		set_user_pass: () => ({ result: {} })
	};
	const view = new Function('view', 'rpc', 'ui', 'uci', 'client', '_', 'E', 'location', 'URL', 'document', 'setTimeout', 'confirm', source)(
		{ extend: value => value },
		{ declare: ({ method }) => (...args) => { calls.push({ method, args }); return Promise.resolve().then(() => (overrides[method] || handlers[method])(...args)); } },
		{ showModal: (title, nodes) => { modal = nodes; }, hideModal: () => { modal = []; }, addNotification: (_, message) => notices.push(text(message)) },
		{ load: () => Promise.resolve(), get: () => '198.51.100.8' }, client, value => value, E,
		{ hostname: 'router.example' }, { createObjectURL: blob => { blobs.push(blob); return 'blob:test'; }, revokeObjectURL() {} },
		{ body: E('body') }, callback => callback(), () => true
	);
	const data = await view.load();
	const dom = view.render(data);
	await flush();
	return { view, dom, calls, notices, downloads, blobs, state, overrides, get modal() { return modal; },
		field: id => flatten(modal).find(node => node.id === 'se-account-' + id),
		button: label => flatten(modal).find(node => node.tag === 'button' && text(node) === label)
	};
}

(async () => {
	// Published SHA-0 test vector, not SHA-1; the username is uppercased before hashing.
	assert.equal(Buffer.from(client.passwordHash('abc', ''), 'base64').toString('hex'), '0164b8a914cd2a5e74c4f7ff082c4d97f1edf880');
	assert.equal(client.passwordHash('secret', 'alice'), client.passwordHash('secret', 'ALICE'));
	// Values cross-checked against DrSaeedHub/Softether-Manager's vpnfile.py.
	for (const [password, username, expected] of [
		['secret', 'alice', 'DngtrNt4kY1zAHmZ2oG8QIkG1FE='],
		['sëcret', 'alice', 'enSyFExm4PMte9O2NrNfaVs5V5U='],
		['x'.repeat(100), 'long-user', '/iVWTL6yT8BbrijvRSx0I8+JQgA='],
		['密码', '用户', 'ImPTThWtNb61/qV8uFmijBXnPgs=']
	]) assert.equal(client.passwordHash(password, username), expected);
	const options = { host: 'vpn.example', port: 443, hub: 'Office $ Team', username: 'alice', authType: 1, password: 'sëcret' };
	const file = client.buildFile(options);
	assert(file.content.startsWith('\ufeff'));
	assert(!file.content.replace(/\r\n/g, '').includes('\n'));
	assert(file.content.includes('string HubName Office$20$24$20Team'));
	assert(file.content.includes('byte HashedPassword ' + client.passwordHash('sëcret', 'alice')));
	assert(!file.content.includes('sëcret'));
	assert.equal(file.filename, 'Office___Team-alice.vpn');
	for (const [authType, clientAuth] of [[0, 0], [1, 1], [2, 3], [3, 3], [4, 2], [5, 2]]) {
		const generated = client.buildFile({ ...options, authType, password: '' }).content;
		assert(generated.includes('uint AuthType ' + clientAuth));
		assert(generated.includes('string PlainPassword $'));
	}
	assert(client.buildFile({ ...options, authType: 4, password: 'radius secret' }).content.includes('string PlainPassword radius$20secret'));
	for (const host of ['https://vpn.example', 'vpn.example:443', 'a@vpn.example', 'vpn.example/path', 'bad\nhost'])
		assert.throws(() => client.buildFile({ ...options, host }));
	assert(client.buildFile({ ...options, host: '2001:db8::1' }).content.includes('string Hostname 2001:db8::1'));
	assert.throws(() => client.buildFile({ ...options, authType: 6 }));
	assert.throws(() => client.buildFile({ ...options, port: 0 }));

	let page = await setup(['OFFICE']);
	assert.equal(page.view.currentHub, 'OFFICE');
	assert(page.calls.filter(call => call.method === 'enum_users').every(call => call.args[0] === 'OFFICE'));
	assert(text(page.dom).includes('密码认证'));
	assert(text(page.dom).includes('RADIUS 认证'));
	page.view.search.value = 'staff'; page.view.search.input();
	assert(text(page.view.userBody).includes('alice'));
	assert(!text(page.view.userBody).includes('radius'));

	page.view.downloadClient(page.state.users[0]);
	assert.equal(page.field('client-host').value, '198.51.100.8');
	assert.equal(page.field('embed').checked, false);
	page.field('embed').checked = true; page.field('embed').change();
	page.field('client-password').value = 'download-secret';
	page.button('下载 .vpn 文件').click();
	assert.deepEqual(page.downloads, ['OFFICE-alice.vpn']);
	const content = await page.blobs[0].text();
	assert(content.includes('string HubName OFFICE'));
	assert(content.includes(client.passwordHash('download-secret', 'alice')));
	assert(!page.calls.some(call => call.args.includes('download-secret')));
	assert.equal(page.modal.length, 0);

	page = await setup();
	page.view.editGroup();
	page.field('group-name').value = 'newgroup'; page.field('group-realname').value = 'New group';
	await page.button('保存用户组').click();
	assert(page.state.groups.some(group => group.Name_str === 'newgroup'));
	assert.equal(page.modal.length, 0);
	page.view.editUser(page.state.users[0]);
	page.field('group').value = 'newgroup';
	await page.button('保存用户').click();
	assert.equal(page.state.users[0].GroupName_str, 'newgroup');
	assert.equal(page.modal.length, 0);

	page.view.editUser();
	page.field('name').value = 'created'; page.field('password').value = 'secret';
	page.field('group').value = 'staff'; page.field('upload').value = '10';
	await page.button('创建用户').click();
	const added = page.calls.find(call => call.method === 'add_user');
	assert.deepEqual(added.args, ['DEFAULT', 'created', 'secret', '', '', '', 10, 0, 0, 'staff']);
	assert(page.state.users.some(user => user.Name_str === 'created'));

	page = await setup();
	page.overrides.set_user_info = () => ({ result: {} }); // Server ignored membership change.
	page.view.editUser(page.state.users[0]); page.field('group').value = '';
	await page.button('保存用户').click();
	assert(page.notices.some(notice => notice.includes('未确认')));
	assert(page.modal.length > 0);
	page.overrides.create_group = () => ({ error: { message: 'Permission denied' } });
	page.view.editGroup(); page.field('group-name').value = 'forbidden';
	await page.button('保存用户组').click();
	assert(page.notices.includes('Permission denied'));
	assert(page.modal.length > 0);

	page = await setup();
	page.overrides.enum_groups = () => ({ error: { message: 'Groups unavailable' } });
	page.view.currentHub = 'OFFICE';
	const refreshing = page.view.refresh();
	page.view.search.input();
	assert(!text(page.view.userBody).includes('alice'));
	await refreshing;
	assert.equal(page.view.addButton.disabled, true);
	assert(text(page.view.errorNode).includes('Groups unavailable'));
	assert(!text(page.view.userBody).includes('alice'));
	console.log('User UI/client checks passed: SHA-0, auth formats, downloads without uploading credentials, group CRUD/membership, errors, and server readback.');
})().catch(error => { console.error(error); process.exitCode = 1; });
