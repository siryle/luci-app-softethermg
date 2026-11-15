'use strict';
// node scripts/test-policy-ui.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync('htdocs/luci-static/resources/view/softethermg/policy.js', 'utf8');
const fields = JSON.parse(fs.readFileSync('root/usr/share/softethermg/policy.json', 'utf8')).fields;
const initial = () => ({ fields, enabled: false, source: 'group', group: 'staff', atomic: true, supported: Object.keys(fields), values: Object.fromEntries(Object.entries(fields).map(([key, definition]) => [key, definition.default])) });
const flatten = nodes => nodes.flatMap(node => typeof node === 'string' ? [] : [node, ...flatten(node.children || [])]);
const text = node => typeof node === 'string' ? node : (node.children || []).map(text).join('');

async function setup({ state = initial(), beforeLoad = null } = {}) {
	let modal = [], closed = false, saved = 0;
	const calls = [], notices = [], overrides = {};
	function E(tag, attrs = {}, children = []) {
		return { tag, ...attrs, value: String(attrs.value ?? ''), checked: !!attrs.checked, children: Array.isArray(children) ? children : [children],
			addEventListener(name, callback) { this[name] = callback; } };
	}
	const handlers = {
		get_policy: async () => { if (beforeLoad) await beforeLoad(); return { result: structuredClone(state) }; },
		set_policy: (kind, hub, name, enabled, values) => { state.enabled = enabled; state.source = enabled ? 'own' : 'group'; Object.assign(state.values, JSON.parse(values)); return { result: {} }; }
	};
	const editor = new Function('baseclass', 'rpc', 'ui', '_', 'E', source)(
		{ extend: value => value },
		{ declare: ({ method }) => (...args) => { calls.push({ method, args }); return Promise.resolve().then(() => (overrides[method] || handlers[method])(...args)); } },
		{ showModal: (title, children) => { modal = children; closed = false; }, hideModal: () => { modal = []; closed = true; }, addNotification: (_, message) => notices.push(text(message)) },
		value => value, E
	);
	const opening = editor.open('user', 'DEFAULT', 'alice', () => { saved++; });
	const page = { editor, state, calls, notices, overrides, opening, get modal() { return modal; }, get closed() { return closed; }, get saved() { return saved; },
		control: key => flatten(modal).find(node => node.id === 'se-policy-' + key),
		button: label => flatten(modal).find(node => node.tag === 'button' && text(node) === label),
		error: () => { const node = flatten(modal).find(node => node.role === 'alert'); return node?.textContent ?? (node ? text(node) : undefined); } };
	if (!beforeLoad) await opening;
	return page;
}

(async () => {
	let page = await setup();
	assert.equal(flatten(page.modal).filter(node => node.tag === 'input').length, 39);
	assert(text({ children: page.modal }).includes('当前继承用户组策略：staff'));
	assert.equal(page.control('MaxUpload').disabled, true);
	page.control('enabled').checked = true; page.control('enabled').change();
	assert.equal(page.control('MaxUpload').disabled, false);
	page.control('MaxUpload').value = '10000000';
	page.control('PrivacyFilter').checked = true;
	const saving = page.button('保存策略').click();
	assert.equal(page.button('保存策略').disabled, true);
	assert.equal(page.button('取消').disabled, true);
	await saving;
	assert.equal(page.closed, true); assert.equal(page.saved, 1);
	const write = page.calls.find(call => call.method === 'set_policy');
	assert.deepEqual(write.args, ['user', 'DEFAULT', 'alice', true, '{"MaxUpload":10000000,"PrivacyFilter":true}']);
	assert(page.notices.some(message => message.includes('服务端确认')));

	page = await setup({ state: { ...initial(), enabled: true, source: 'own' } });
	page.control('enabled').checked = false; page.control('enabled').change();
	await page.button('保存策略').click();
	assert.deepEqual(page.calls.find(call => call.method === 'set_policy').args.slice(3), [false, '{}']);

	for (const [key, value] of [['MaxUpload', '4294967296'], ['TimeOut', '0'], ['MaxConnection', '33'], ['VLanId', '4096'], ['MaxIP', '-1'], ['MultiLogins', '1.5']]) {
		page = await setup(); page.control('enabled').checked = true; page.control('enabled').change(); page.control(key).value = value;
		await page.button('保存策略').click();
		assert(!page.calls.some(call => call.method === 'set_policy'));
		assert.match(page.error(), /请检查策略数值/);
	}

	page = await setup({ state: { ...initial(), supported: Object.keys(fields).filter(key => key !== 'RAFilter'), atomic: false } });
	page.control('enabled').checked = true; page.control('enabled').change();
	assert.equal(page.control('RAFilter').disabled, true);
	assert(text({ children: page.modal }).includes('分步写入'));
	page.control('RAFilter').checked = true;
	page.control('MaxDownload').value = '5000';
	await page.button('保存策略').click();
	assert.deepEqual(JSON.parse(page.calls.find(call => call.method === 'set_policy').args[4]), { MaxDownload: 5000 });

	page = await setup();
	page.overrides.set_policy = () => ({ error: { message: 'Partial failure' } });
	page.control('enabled').checked = true; page.control('enabled').change(); page.control('MaxUpload').value = '1000';
	await page.button('保存策略').click();
	assert.equal(page.closed, false); assert.match(page.error(), /Partial failure/);
	assert.equal(page.control('enabled').checked, false);
	assert.equal(page.control('MaxUpload').value, '0');

	page = await setup();
	page.overrides.set_policy = () => ({ result: {} });
	page.control('enabled').checked = true; page.control('enabled').change();
	await page.button('保存策略').click();
	assert.match(page.error(), /未应用全部修改/);
	assert.equal(page.closed, false);

	page = await setup();
	page.overrides.set_policy = () => { throw Error('Connection lost'); };
	page.overrides.get_policy = () => { throw Error('Readback unavailable'); };
	page.control('enabled').checked = true; page.control('enabled').change();
	await page.button('保存策略').click();
	assert.equal(page.button('保存策略').disabled, true);
	assert.equal(page.button('取消').disabled, false);
	assert.match(page.error(), /无法读取实际状态/);

	let finish;
	const loading = new Promise(resolve => { finish = resolve; });
	page = await setup({ beforeLoad: () => loading });
	page.button('取消').click(); finish(); await page.opening;
	assert.equal(page.closed, true);
	assert.equal(page.modal.length, 0);
	console.log('Policy UI checks passed: 38 fields, inheritance, changed-field patches, ranges, unsupported fields, readback failures and cancellation.');
})().catch(error => { console.error(error); process.exitCode = 1; });
