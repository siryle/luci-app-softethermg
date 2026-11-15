'use strict';
// node scripts/test-server-ui.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync('htdocs/luci-static/resources/view/softethermg/server.js', 'utf8');
String.prototype.format ??= function(value) { return this.replace('%s', value); };
const cert = Buffer.from([0x30, 3, 2, 1, 1]);
const replacement = Buffer.from([0x30, 3, 2, 1, 2]);
const privateKey = Buffer.from('-----BEGIN PRIVATE KEY-----\nMAMCAQI=\n-----END PRIVATE KEY-----\n');
const config = Buffer.from('declare root\r\n{\r\n string Secret confidential\r\n}\r\n');
const encoded = data => Buffer.from(data).toString('base64');
const pem = data => '-----BEGIN CERTIFICATE-----\n' + encoded(data) + '\n-----END CERTIFICATE-----\n';
const file = data => ({ size: data.length, arrayBuffer: async () => Uint8Array.from(data).buffer });

async function setup(overrides = {}) {
	const state = { cert: encoded(cert), listeners: [
		{ Ports_u32: 443, Enables_bool: true, Errors_bool: false },
		{ Ports_u32: 992, Enables_bool: false, Errors_bool: false },
		{ Ports_u32: 5555, Enables_bool: true, Errors_bool: false }
	] };
	const calls = [], notices = [], downloads = [], blobs = [], nodes = [];
	const handlers = {
		enum_listeners: () => ({ result: { ListenerList: structuredClone(state.listeners) } }),
		get_server_cert: () => ({ result: { Cert_bin: state.cert } }),
		create_listener: port => { state.listeners.push({ Ports_u32: port, Enables_bool: true, Errors_bool: false }); return { result: {} }; },
		set_listener: (port, enabled) => { state.listeners.find(listener => listener.Ports_u32 === port).Enables_bool = enabled; return { result: {} }; },
		delete_listener: port => { state.listeners = state.listeners.filter(listener => listener.Ports_u32 !== port); return { result: {} }; },
		set_server_cert: cert => { state.cert = cert; return { result: {} }; },
		regenerate_server_cert: () => { state.cert = encoded(replacement); return { result: {} }; },
		backup_config: () => ({ result: { FileData_bin: encoded(config) } })
	};
	function E(tag, attrs = {}, children = []) {
		const node = { tag, ...attrs, value: String(attrs.value ?? ''), files: [], children: (Array.isArray(children) ? children : [children]),
			replaceChildren(...children) { this.children = children; }, appendChild(child) { this.children.push(child); }, remove() {} };
		if (tag === 'a') node.click = () => downloads.push(node.download);
		nodes.push(node); return node;
	}
	const view = new Function('view', 'rpc', 'ui', 'uci', '_', 'E', 'location', 'URL', 'document', 'setTimeout', 'confirm', source)(
		{ extend: value => value },
		{ declare: ({ method }) => (...args) => { calls.push({ method, args }); return Promise.resolve().then(() => (overrides[method] || handlers[method])(...args)); } },
		{ addNotification: (_, message) => notices.push(message.children.join('')) },
		{ load: () => Promise.resolve(true), get: (config, section, option) => option === 'api_port' ? '5555' : '198.51.100.8' },
		value => value, E, { hostname: 'router.example' },
		{ createObjectURL: blob => { blobs.push(blob); return 'blob:test'; }, revokeObjectURL() {} },
		{ body: E('body') }, callback => callback(), () => true
	);
	view.render(await view.load());
	return { view, state, calls, notices, downloads, blobs, overrides, nodes };
}

(async () => {
	let page = await setup();
	assert.equal(page.view.listenerReady, true);
	assert.equal(page.view.certDownload.disabled, false);
	const protectedRow = page.view.listenerBody.children.find(row => String(row.children[0].children).includes('5555'));
	assert(protectedRow.children[2].children.filter(node => typeof node === 'object').every(button => button.disabled));
	await page.view.changeListener('create', 1194);
	assert(page.state.listeners.some(listener => listener.Ports_u32 === 1194));
	await page.view.changeListener('set', 992, true);
	assert.equal(page.state.listeners.find(listener => listener.Ports_u32 === 992).Enables_bool, true);
	await page.view.changeListener('delete', 992);
	assert(!page.view.listeners.some(listener => listener.Ports_u32 === 992));
	assert.match(page.view.listenerMessage.textContent, /服务端确认/);
	const calls = page.calls.length;
	await page.view.changeListener('create', 0);
	assert.equal(page.calls.length, calls);

	page = await setup({ create_listener: () => ({ result: {} }) });
	await page.view.changeListener('create', 1194);
	assert.match(page.view.listenerMessage.textContent, /未应用/);
	page = await setup();
	page.overrides.create_listener = port => { page.state.listeners.push({ Ports_u32: port, Enables_bool: true, Errors_bool: true }); return { result: {} }; };
	await page.view.changeListener('create', 1194);
	assert.match(page.view.listenerMessage.textContent, /无法监听/);

	page = await setup();
	page.view.certDownload.click();
	assert.deepEqual(page.downloads, ['softether-server.crt']);
	assert.equal(await page.blobs[0].text(), pem(cert));
	await page.view.backup();
	assert.equal(page.downloads[1], 'vpn_server.config');
	assert.deepEqual(Buffer.from(await page.blobs[1].arrayBuffer()), config);
	page.view.certFile.files = [file(Buffer.from(pem(replacement)))];
	page.view.keyFile.files = [file(privateKey)];
	const importing = page.view.replaceCertificate();
	assert.equal(page.view.replaceButton.disabled, true);
	assert.equal(page.view.regenerateButton.disabled, true);
	await importing;
	assert.match(page.view.certMessage.textContent, /已替换/);
	assert.equal(page.view.certInfo.der, encoded(replacement));
	assert.equal(page.view.keyFile.value, '');
	assert.equal(page.view.replaceButton.disabled, false);
	const imported = page.calls.find(call => call.method === 'set_server_cert');
	assert.equal(imported.args[1], encoded(privateKey));

	page = await setup();
	page.view.certFile.files = [file(cert)];
	page.view.keyFile.files = [file(Buffer.from('-----BEGIN ENCRYPTED PRIVATE KEY-----\nMAMCAQI=\n-----END ENCRYPTED PRIVATE KEY-----'))];
	await page.view.replaceCertificate();
	assert.match(page.view.certMessage.textContent, /未加密/);
	assert(!page.calls.some(call => call.method === 'set_server_cert'));
	page.view.keyFile.files = [file(privateKey)];
	page.view.certFile.files = [{ size: 65537 }];
	await page.view.replaceCertificate();
	assert.match(page.view.certMessage.textContent, /64 KiB/);
	page.view.certFile.files = [file(Buffer.from(pem(cert) + pem(replacement)))];
	await page.view.replaceCertificate();
	assert.match(page.view.certMessage.textContent, /单个/);

	page = await setup({ set_server_cert: () => ({ result: {} }) });
	page.view.certFile.files = [file(replacement)]; page.view.keyFile.files = [file(privateKey)];
	await page.view.replaceCertificate();
	assert.match(page.view.certMessage.textContent, /不同/);
	page = await setup({ regenerate_server_cert: () => ({ result: {} }) });
	await page.view.regenerateCertificate();
	assert.match(page.view.certMessage.textContent, /未发生变化/);
	page = await setup();
	await page.view.regenerateCertificate();
	assert.match(page.view.certMessage.textContent, /新自签证书已启用/);
	page.view.commonName.value = 'bad /CMD:inject';
	const before = page.calls.length;
	await page.view.regenerateCertificate();
	assert.equal(page.calls.length, before);

	page = await setup({ get_server_cert: () => ({ error: { message: 'Certificate denied' } }) });
	assert.equal(page.view.listenerReady, true);
	assert.equal(page.view.certDownload.disabled, true);
	assert.equal(page.view.replaceButton.disabled, true);
	assert.equal(page.view.certMessage.textContent, 'Certificate denied');
	page.overrides.backup_config = () => ({ error: { message: 'Backup denied' } });
	await page.view.backup();
	assert(page.notices.some(notice => notice.includes('Backup denied')));
	assert.equal(page.downloads.length, 0);
	assert.equal(page.view.backupButton.disabled, false);
	page = await setup({ enum_listeners: () => ({ result: {} }) });
	assert.equal(page.view.addButton.disabled, true);
	assert.match(page.view.listenerMessage.textContent, /有效的 TCP 监听列表/);
	console.log('Server UI checks passed: listener readback, current-port protection, certificate export/import/regeneration, backup bytes, validation and failure states.');
})().catch(error => { console.error(error); process.exitCode = 1; });
