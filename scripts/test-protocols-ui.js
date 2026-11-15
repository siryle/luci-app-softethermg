'use strict';
// Offline LuCI view checks: node scripts/test-protocols-ui.js
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('htdocs/luci-static/resources/view/softethermg/protocols.js', 'utf8');
const zip = Buffer.from('PK\x03\x04test-archive', 'binary');

async function setup({ enabled = true, failLoad = false } = {}) {
	const nodes = [], notices = [], calls = [], downloads = [];
	let blob, modal = false;
	const state = {
		ipsec: { L2TP_IPsec_bool: true, L2TP_Raw_bool: false, EtherIP_IPsec_bool: true, IPsec_Secret_str: 'vpn', L2TP_DefaultHub_str: 'DEFAULT' },
		openvpn: { EnableOpenVPN_bool: enabled, OpenVPNPortList_str: '1194,5555', EnableSSTP_bool: true }
	};
	const responses = {};
	const handlers = {
		get_ipsec: () => ({ result: { ...state.ipsec } }),
		get_openvpn: () => ({ result: { ...state.openvpn } }),
		enum_hubs: () => failLoad ? Promise.reject(new Error('Hub list unavailable')) : ({ result: { HubList: [{ HubName_str: 'DEFAULT' }] } }),
		make_openvpn_config: () => ({ result: { Buffer_bin: zip.toString('base64') } }),
		set_ipsec: (l2tp, psk, hub, raw, etherip) => {
			Object.assign(state.ipsec, { L2TP_IPsec_bool: l2tp, IPsec_Secret_str: psk, L2TP_DefaultHub_str: hub, L2TP_Raw_bool: raw, EtherIP_IPsec_bool: etherip });
			return { result: {} };
		},
		set_openvpn: (openvpn, ports, sstp) => {
			Object.assign(state.openvpn, { EnableOpenVPN_bool: openvpn, OpenVPNPortList_str: ports, EnableSSTP_bool: sstp });
			return { result: {} };
		}
	};
	function E(tag, attrs = {}, children = []) {
		const node = { tag, ...attrs, children, remove() {} };
		if (tag === 'select') node.value = (children.find(child => child.selected) || children[0])?.value || '';
		if (tag === 'a') node.click = () => downloads.push(node.download);
		nodes.push(node);
		return node;
	}
	const view = new Function('view', 'rpc', 'ui', '_', 'E', 'document', 'URL', 'setTimeout', source)(
		{ extend: value => value },
		{ declare: ({ method }) => (...args) => {
			calls.push({ method, args });
			return Promise.resolve().then(() => (responses[method] || handlers[method])(...args));
		} },
		{
			showModal: () => { modal = true; }, hideModal: () => { modal = false; },
			addNotification: (_, message) => notices.push(message.children)
		},
		value => value, E, { body: { appendChild() {} } },
		{ createObjectURL: value => { blob = value; return 'blob:test'; }, revokeObjectURL() {} },
		callback => callback()
	);
	const data = await view.load();
	view.render(data);
	return {
		nodes, notices, calls, downloads, responses, state,
		get modal() { return modal; }, get blob() { return blob; },
		download: nodes.find(node => node.tag === 'button' && String(node.children).includes('下载 OpenVPN')),
		save: nodes.find(node => node.tag === 'button' && node.children === '保存并应用设置'),
		input: id => nodes.find(node => node.id === id)
	};
}

(async () => {
	let page = await setup();
	const request = page.download.click();
	assert.equal(page.download.disabled, true);
	await request;
	assert.deepEqual(page.downloads, ['openvpn_config.zip']);
	assert.deepEqual(Buffer.from(await page.blob.arrayBuffer()), zip);
	assert.equal(page.blob.type, 'application/zip');
	assert.equal(page.download.disabled, false);

	for (const reply of [{ error: { message: 'OpenVPN disabled by server' } }, { result: {} }, { result: { Buffer_bin: 'bm90LXppcA==' } }]) {
		page = await setup();
		page.responses.make_openvpn_config = () => reply;
		await page.download.click();
		assert.equal(page.downloads.length, 0);
		assert.match(page.notices[0], /下载 OpenVPN 模板失败/);
		assert.equal(page.download.disabled, false);
	}

	page = await setup({ enabled: false });
	assert.equal(page.download.disabled, true);
	page.input('se-openvpn').checked = true;
	page.input('se-l2tp-raw').checked = true;
	page.input('se-etherip').checked = false;
	page.input('se-sstp').checked = false;
	const saving = page.save.click();
	assert.equal(page.save.disabled, true);
	assert.equal(page.download.disabled, true);
	assert.equal(page.modal, true);
	await saving;
	assert.equal(page.modal, false);
	assert.equal(page.save.disabled, false);
	assert.equal(page.download.disabled, false);
	assert.match(page.notices[0], /已保存/);
	assert.deepEqual(page.calls.find(call => call.method === 'set_ipsec').args, [true, 'vpn', 'DEFAULT', true, false]);
	assert.deepEqual(page.calls.find(call => call.method === 'set_openvpn').args, [true, '1194,5555', false]);
	assert.equal(page.calls.filter(call => call.method === 'get_openvpn').length, 2);

	page = await setup();
	page.responses.set_openvpn = () => ({ error: { message: 'Permission denied' } });
	await page.save.click();
	assert(page.notices.some(message => message.includes('Permission denied')));
	assert(!page.notices.some(message => message.includes('已保存')));
	assert.equal(page.save.disabled, false);

	page = await setup();
	page.input('se-openvpn').checked = false;
	page.responses.set_openvpn = () => ({ result: {} }); // Server ignored the write.
	await page.save.click();
	assert.equal(page.input('se-openvpn').checked, true);
	assert(page.notices.some(message => message.includes('服务端未应用全部设置')));

	for (const ports of ['0', '65536', '1194;444', '1194,']) {
		page = await setup();
		page.input('se-openvpn-ports').value = ports;
		await page.save.click();
		assert(!page.calls.some(call => call.method.startsWith('set_')));
		assert.match(page.notices[0], /请输入/);
	}

	page = await setup({ failLoad: true });
	assert.equal(page.save.disabled, true);
	assert(page.nodes.some(node => node.role === 'alert' && node.children === 'Hub list unavailable'));
	console.log('Protocol UI checks passed: ZIP download, errors, disabled states, validation, and server readback.');
})().catch(error => { console.error(error); process.exitCode = 1; });
