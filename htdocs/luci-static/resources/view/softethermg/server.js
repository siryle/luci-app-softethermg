'use strict';
'require view';
'require rpc';
'require ui';
'require uci';

const declare = (method, params = []) => rpc.declare({ object: 'luci.softethermg', method, params, expect: { '': {} } });
const callListeners = declare('enum_listeners');
const callCreate = declare('create_listener', ['port']);
const callToggle = declare('set_listener', ['port', 'enabled']);
const callDelete = declare('delete_listener', ['port']);
const callCertificate = declare('get_server_cert');
const callReplace = declare('set_server_cert', ['cert', 'key']);
const callRegenerate = declare('regenerate_server_cert', ['common_name']);
const callBackup = declare('backup_config');

function result(response) {
	if (response?.error) throw new Error(response.error.message || _('SoftEther 操作失败'));
	if (!response?.result) throw new Error(_('服务端未返回有效结果。'));
	return response.result;
}

function listenerList(response) {
	const list = result(response).ListenerList;
	if (!Array.isArray(list)) throw new Error(_('服务端未返回有效的 TCP 监听列表。'));
	return list;
}

function bytes(encoded) {
	if (typeof encoded !== 'string' || !encoded) throw new Error(_('服务端文件为空。'));
	return Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
}

function base64(data) {
	return btoa(Array.from(data, value => String.fromCharCode(value)).join(''));
}

function certificate(encoded) {
	let data = bytes(encoded);
	const text = new TextDecoder().decode(data);
	if (text.includes('-----BEGIN')) {
		const blocks = Array.from(text.matchAll(/-----BEGIN CERTIFICATE-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END CERTIFICATE-----/g));
		if (blocks.length !== 1) throw new Error(_('请选择单个 PEM 或 DER 格式的服务器证书。'));
		data = bytes(blocks[0][1].replace(/\s/g, ''));
	}
	if (data.length < 4 || data[0] !== 0x30) throw new Error(_('证书不是有效的 PEM 或 DER 文件。'));
	const der = base64(data);
	return { der, pem: '-----BEGIN CERTIFICATE-----\n' + der.match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n' };
}

function download(data, filename, type = 'application/octet-stream') {
	const url = URL.createObjectURL(new Blob([data], { type }));
	const link = E('a', { href: url, download: filename, hidden: true });
	document.body.appendChild(link); link.click(); link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function field(label, control, description) {
	return E('div', { 'class': 'cbi-value' }, [
		E('label', { 'class': 'cbi-value-title', 'for': control.id }, label),
		E('div', { 'class': 'cbi-value-field' }, [control, ...(description ? [E('div', { 'class': 'cbi-value-description' }, description)] : [])])
	]);
}

async function readFile(file) {
	if (!file || !file.size || file.size > 65536) throw new Error(_('请选择不超过 64 KiB 的非空证书或私钥文件。'));
	return new Uint8Array(await file.arrayBuffer());
}

return view.extend({
	load: function() {
		return Promise.all([
			callListeners().catch(error => ({ error: { message: error.message } })),
			callCertificate().catch(error => ({ error: { message: error.message } })),
			uci.load('softethermg').catch(() => null)
		]);
	},

	render: function(data) {
		this.currentPort = Number(uci.get('softethermg', 'global', 'api_port') || 5555);
		this.configReady = data[2] !== null;
		this.listeners = []; this.listenerReady = false; this.listenerBusy = false;
		this.certInfo = null; this.certBusy = false;
		this.listenerBody = E('tbody');
		this.listenerMessage = E('p', { role: 'status' });
		this.certMessage = E('p', { role: 'status' });
		this.portInput = E('input', { id: 'se-server-port', type: 'number', min: 1, max: 65535, step: 1, value: '443', 'class': 'cbi-input-text' });
		this.addButton = E('button', { type: 'button', 'class': 'cbi-button cbi-button-add', click: () => this.changeListener('create', Number(this.portInput.value)) }, _('添加并启用端口'));
		this.certText = E('textarea', { id: 'se-server-cert', readonly: true, rows: 8, 'class': 'cbi-input-textarea', 'style': 'width:100%;max-width:100%;box-sizing:border-box;' });
		this.certFile = E('input', { id: 'se-server-cert-file', type: 'file', accept: '.pem,.crt,.cer,.der', 'style': 'max-width:100%;' });
		this.keyFile = E('input', { id: 'se-server-key-file', type: 'file', accept: '.pem,.key,.der', 'style': 'max-width:100%;' });
		const target = uci.get('softethermg', 'global', 'api_host');
		this.commonName = E('input', { id: 'se-server-cn', type: 'text', maxlength: 253, 'class': 'cbi-input-text', value: target && !['127.0.0.1', '::1', 'localhost'].includes(target) ? target : location.hostname.replace(/^\[|\]$/g, '') });
		this.certDownload = E('button', { type: 'button', 'class': 'cbi-button cbi-button-action', click: () => download(this.certInfo.pem, 'softether-server.crt', 'application/x-pem-file') }, _('下载公钥证书'));
		this.replaceButton = E('button', { type: 'button', 'class': 'cbi-button cbi-button-apply', click: () => this.replaceCertificate() }, _('替换服务器证书'));
		this.regenerateButton = E('button', { type: 'button', 'class': 'cbi-button cbi-button-action', click: () => this.regenerateCertificate() }, _('生成并启用自签证书'));
		this.backupButton = E('button', { type: 'button', 'class': 'cbi-button cbi-button-action', click: () => this.backup() }, _('下载配置备份 (.config)'));
		const refresh = E('button', { type: 'button', 'class': 'cbi-button cbi-button-action', click: () => {
			refresh.disabled = true;
			return Promise.allSettled([this.refreshListeners(), this.refreshCertificate()]).finally(() => { refresh.disabled = false; });
		} }, _('刷新状态'));
		const content = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('SoftEther 服务器管理')), E('p', {}, _('管理服务端监听端口、服务器证书和配置备份。所有操作作用于基本设置中连接的 SoftEther 实例。')), refresh,
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('TCP 监听端口')),
				E('p', {}, _('TCP 端口供 SoftEther、SSTP 和管理连接使用，OpenVPN UDP 端口在协议设置中配置。当前面板连接端口不能停用或删除；请先在基本设置中切换连接端口。窄屏可横向滚动表格。')),
				this.listenerMessage,
				E('div', { 'style': 'overflow-x:auto;' }, E('table', { 'class': 'table cbi-section-table', 'style': 'min-width:480px;' }, [
					E('thead', {}, E('tr', { 'class': 'tr table-titles' }, [_('TCP 端口'), _('服务端状态'), _('操作')].map(title => E('th', { 'class': 'th' }, title)))), this.listenerBody
				])),
				field(_('新增 TCP 端口'), this.portInput), this.addButton
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('服务器证书')), E('p', {}, _('查看和下载服务器公钥证书，或上传匹配的证书与未加密私钥。证书更换后，客户端可能需要重新确认信任。')),
				this.certMessage, field(_('当前公钥证书'), this.certText), this.certDownload,
				field(_('新证书文件'), this.certFile, _('单个 PEM 或 DER 格式证书，最大 64 KiB。')),
				field(_('匹配的私钥'), this.keyFile, _('PEM 或 DER 格式，最大 64 KiB。私钥仅用于此次导入，临时文件在操作后清理。')),
				this.replaceButton, field(_('自签证书域名 / IP'), this.commonName), this.regenerateButton
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('配置备份')), E('p', {}, _('备份包含 SoftEther 的账号资料、密码散列及服务器私钥，请存放在可信位置。此文件由当前连接的服务端导出。')), this.backupButton
			])
		]);
		try { this.listeners = listenerList(data[0]); this.listenerReady = true; }
		catch (error) { this.listenerMessage.textContent = error.message; }
		if (!this.configReady) this.listenerMessage.textContent = _('无法读取面板连接端口，请刷新页面后再修改监听器。');
		this.renderListeners();
		try { this.updateCertificate(data[1]); }
		catch (error) { this.certMessage.textContent = error.message; }
		this.lockCertificate(false);
		return content;
	},

	renderListeners: function() {
		this.listenerBody.replaceChildren();
		this.addButton.disabled = !this.listenerReady || !this.configReady || this.listenerBusy;
		for (const listener of this.listeners) {
			const port = Number(listener.Ports_u32);
			const protectedPort = port === this.currentPort;
			const disabled = !this.configReady || this.listenerBusy;
			this.listenerBody.appendChild(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, String(port) + (protectedPort ? _('（当前管理端口）') : '')),
				E('td', { 'class': 'td' }, listener.Errors_bool ? _('无法监听：检查端口占用或权限') : listener.Enables_bool ? _('正在监听') : _('已停用')),
				E('td', { 'class': 'td cbi-section-actions' }, [
					E('button', { type: 'button', disabled: disabled || protectedPort, 'class': 'cbi-button cbi-button-action', click: () => this.changeListener('set', port, !listener.Enables_bool) }, listener.Enables_bool ? _('停用') : _('启用')),
					' ', E('button', { type: 'button', disabled: disabled || protectedPort, 'class': 'cbi-button cbi-button-remove', click: () => {
						if (confirm(_('确定删除 TCP 监听端口 %s 吗？').format(port))) return this.changeListener('delete', port);
					} }, _('删除'))
				])
			]));
		}
		if (!this.listeners.length) this.listenerBody.appendChild(E('tr', { 'class': 'tr' }, E('td', { colspan: 3 }, this.listenerReady ? _('服务端没有配置 TCP 监听端口') : _('无法读取监听端口'))));
	},

	refreshListeners: function() {
		return callListeners().then(listenerList).then(list => { this.listeners = list; this.listenerReady = true; this.listenerMessage.textContent = this.configReady ? '' : _('无法读取面板连接端口，请刷新页面后再修改监听器。'); })
			.catch(error => { this.listenerReady = false; this.listeners = []; this.listenerMessage.textContent = error.message; throw error; })
			.finally(() => this.renderListeners());
	},

	changeListener: async function(action, port, enabled = true) {
		if (!Number.isInteger(port) || port < 1 || port > 65535) { this.listenerMessage.textContent = _('端口必须是 1–65535 范围的整数。'); return; }
		if (this.listenerBusy || !this.configReady || !this.listenerReady) return;
		this.listenerBusy = true; this.listenerMessage.textContent = _('正在修改并读取服务端状态...'); this.renderListeners();
		try {
			await (action === 'create' ? callCreate(port) : action === 'delete' ? callDelete(port) : callToggle(port, enabled)).then(result);
			await this.refreshListeners();
			const actual = this.listeners.find(listener => Number(listener.Ports_u32) === port);
			if (action === 'delete' ? !!actual : !actual || !!actual.Enables_bool !== enabled)
				throw new Error(_('服务端未应用此次端口修改，页面显示的是实际状态。'));
			if (actual?.Errors_bool) throw new Error(_('端口已配置，但服务端无法监听，请检查端口占用或权限。'));
			this.listenerMessage.textContent = _('端口设置已由服务端确认。');
		} catch (error) { this.listenerMessage.textContent = error.message; }
		finally { this.listenerBusy = false; this.renderListeners(); }
	},

	updateCertificate: function(response) {
		this.certInfo = certificate(result(response).Cert_bin);
		this.certText.value = this.certInfo.pem;
		this.certMessage.textContent = '';
	},

	refreshCertificate: function() {
		return callCertificate().then(response => this.updateCertificate(response)).catch(error => {
			this.certInfo = null; this.certText.value = ''; this.certMessage.textContent = error.message; throw error;
		}).finally(() => this.lockCertificate(this.certBusy));
	},

	lockCertificate: function(busy) {
		this.certBusy = busy;
		this.certDownload.disabled = this.replaceButton.disabled = this.regenerateButton.disabled = busy || !this.certInfo;
		this.certFile.disabled = this.keyFile.disabled = this.commonName.disabled = busy;
	},

	replaceCertificate: async function() {
		if (this.certBusy || !this.certInfo) return;
		if (!this.certFile.files[0] || !this.keyFile.files[0]) { this.certMessage.textContent = _('请选择服务器证书和匹配的未加密私钥。'); return; }
		if (!confirm(_('替换服务器证书和私钥后，客户端可能需要重新确认信任。确定替换吗？'))) return;
		this.lockCertificate(true); this.certMessage.textContent = _('正在上传并核对服务器证书...');
		try {
			const certBytes = await readFile(this.certFile.files[0]);
			const keyBytes = await readFile(this.keyFile.files[0]);
			const expected = certificate(base64(certBytes));
			const keyText = new TextDecoder().decode(keyBytes);
			if (/BEGIN ENCRYPTED PRIVATE KEY|Proc-Type:\s*4,ENCRYPTED/i.test(keyText)) throw new Error(_('请使用未加密私钥。'));
			if (keyBytes[0] !== 0x30 && !/-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/.test(keyText)) throw new Error(_('请选择 PEM 或 DER 格式的私钥。'));
			await callReplace(base64(certBytes), base64(keyBytes)).then(result);
			await this.refreshCertificate();
			if (this.certInfo.der !== expected.der) throw new Error(_('服务端返回的证书与上传证书不同，请核对实际证书。'));
			this.certMessage.textContent = _('服务器证书已替换，并已读取服务端确认。');
		} catch (error) { this.certMessage.textContent = error.message; }
		finally { this.certFile.value = ''; this.keyFile.value = ''; this.lockCertificate(false); }
	},

	regenerateCertificate: async function() {
		if (this.certBusy || !this.certInfo) return;
		const name = this.commonName.value.trim();
		if (!name || name.length > 253 || !/^[a-zA-Z0-9._:*\-]+$/.test(name)) { this.certMessage.textContent = _('请输入有效的域名或 IP 地址。'); return; }
		if (!confirm(_('这会替换当前证书和私钥，使用新自签证书的客户端需要重新确认信任。确定生成吗？'))) return;
		const before = this.certInfo.der;
		this.lockCertificate(true); this.certMessage.textContent = _('正在生成并核对新证书...');
		try {
			await callRegenerate(name).then(result);
			await this.refreshCertificate();
			if (this.certInfo.der === before) throw new Error(_('服务端证书未发生变化，请核对生成结果。'));
			this.certMessage.textContent = _('新自签证书已启用，可下载并在客户端重新确认信任。');
		} catch (error) { this.certMessage.textContent = error.message; }
		finally { this.lockCertificate(false); }
	},

	backup: async function() {
		this.backupButton.disabled = true;
		try { download(bytes(result(await callBackup()).FileData_bin), 'vpn_server.config'); }
		catch (error) { ui.addNotification(null, E('p', {}, _('配置备份失败：') + error.message)); }
		finally { this.backupButton.disabled = false; }
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
