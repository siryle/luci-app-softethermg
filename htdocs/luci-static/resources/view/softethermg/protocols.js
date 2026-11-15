'use strict';
'require view';
'require rpc';
'require ui';

const callGetIPsec = rpc.declare({
	object: 'luci.softethermg',
	method: 'get_ipsec',
	expect: { '': {} }
});

const callSetIPsec = rpc.declare({
	object: 'luci.softethermg',
	method: 'set_ipsec',
	params: ['l2tp', 'psk', 'hub', 'raw_l2tp', 'etherip']
});

const callGetOpenVPN = rpc.declare({
	object: 'luci.softethermg',
	method: 'get_openvpn',
	expect: { '': {} }
});

const callSetOpenVPN = rpc.declare({
	object: 'luci.softethermg',
	method: 'set_openvpn',
	params: ['openvpn', 'ports', 'sstp']
});

const callMakeOpenVPNConfig = rpc.declare({
	object: 'luci.softethermg',
	method: 'make_openvpn_config',
	expect: { '': {} }
});

const callEnumHubs = rpc.declare({
	object: 'luci.softethermg',
	method: 'enum_hubs',
	expect: { '': {} }
});

function rpcResult(response) {
	if (response?.error)
		throw new Error(response.error.message || _('SoftEther 操作失败'));
	if (!response?.result)
		throw new Error(_('服务端未返回有效结果，请检查连接设置。'));
	return response.result;
}

function normalizePorts(value) {
	return value.trim().split(/[ ,]+/).map(Number).sort((a, b) => a - b).join(',');
}

return view.extend({
	load: function() {
		return Promise.all([
			callGetIPsec(),
			callGetOpenVPN(),
			callEnumHubs()
		].map(request => request.catch(error => ({ error: { message: error.message || String(error) } }))));
	},

	render: function(data) {
		const ipsec = data[0].result || {};
		const openvpn = data[1].result || {};
		const hubs = data[2].result?.HubList || [];
		const errors = data.filter(response => response.error || !response.result);
		const hubNames = Array.from(new Set(hubs.map(h => h.HubName_str).concat(ipsec.L2TP_DefaultHub_str || []).filter(Boolean)));

		let l2tpCheck, rawL2tpCheck, etheripCheck, pskInput, defaultHubSelect;
		let ovpnCheck, portInput, sstpCheck, saveButton, downloadButton;

		const viewNode = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('VPN 协议与客户端接入设置')),
			E('div', { 'class': 'cbi-map-descr' }, _('配置 L2TP/IPsec、OpenVPN 与 SSTP 接入协议，并下载服务端生成的 OpenVPN 客户端配置。')),
			...errors.map(response => E('p', { 'class': 'alert-message warning', 'role': 'alert' },
				response.error?.message || _('读取协议设置失败，请检查服务端连接后刷新页面。'))),

			E('fieldset', { 'class': 'cbi-section', 'disabled': !data[0].result }, [
				E('legend', {}, _('L2TP / IPsec / EtherIP')),
				E('div', { 'class': 'cbi-section-node' }, [
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': 'se-l2tp' }, _('启用 L2TP over IPsec')),
						E('div', { 'class': 'cbi-value-field' }, [
							l2tpCheck = E('input', { 'id': 'se-l2tp', 'type': 'checkbox', 'checked': !!ipsec.L2TP_IPsec_bool })
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': 'se-l2tp-raw' }, _('启用 Raw L2TP')),
						E('div', { 'class': 'cbi-value-field' }, [
							rawL2tpCheck = E('input', { 'id': 'se-l2tp-raw', 'type': 'checkbox', 'checked': !!ipsec.L2TP_Raw_bool }),
							E('div', { 'class': 'cbi-value-description' }, _('不提供加密，仅用于需要直接连接 L2TP 的设备。'))
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': 'se-etherip' }, _('启用 EtherIP / L2TPv3 over IPsec')),
						E('div', { 'class': 'cbi-value-field' }, [
							etheripCheck = E('input', { 'id': 'se-etherip', 'type': 'checkbox', 'checked': !!ipsec.EtherIP_IPsec_bool }),
							E('div', { 'class': 'cbi-value-description' }, _('用于路由器之间的站点互联；客户端 ID 与 HUB 的映射需在 SoftEther 服务端配置。'))
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': 'se-ipsec-psk' }, _('IPsec 预共享密钥 (PSK)')),
						E('div', { 'class': 'cbi-value-field' }, [
							pskInput = E('input', { 'id': 'se-ipsec-psk', 'type': 'text', 'class': 'cbi-input-text', 'value': ipsec.IPsec_Secret_str ?? 'vpn' })
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': 'se-default-hub' }, _('默认登录虚拟 HUB')),
						E('div', { 'class': 'cbi-value-field' }, [
							defaultHubSelect = E('select', { 'id': 'se-default-hub', 'class': 'cbi-input-select' },
								hubNames.map(name => E('option', { 'value': name, 'selected': name === ipsec.L2TP_DefaultHub_str }, name)))
						])
					])
				])
			]),

			E('fieldset', { 'class': 'cbi-section', 'disabled': !data[1].result }, [
				E('legend', {}, _('OpenVPN 与 MS-SSTP 协议')),
				E('div', { 'class': 'cbi-section-node' }, [
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': 'se-openvpn' }, _('启用 OpenVPN 服务')),
						E('div', { 'class': 'cbi-value-field' }, [
							ovpnCheck = E('input', { 'id': 'se-openvpn', 'type': 'checkbox', 'checked': !!openvpn.EnableOpenVPN_bool })
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': 'se-openvpn-ports' }, _('OpenVPN 监听端口列表')),
						E('div', { 'class': 'cbi-value-field' }, [
							portInput = E('input', { 'id': 'se-openvpn-ports', 'type': 'text', 'class': 'cbi-input-text', 'value': openvpn.OpenVPNPortList_str || '1194' }),
							E('div', { 'class': 'cbi-value-description' }, _('多个 UDP 端口用逗号或空格隔开，范围为 1–65535。'))
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': 'se-sstp' }, _('启用 MS-SSTP 协议 (Windows 自带)')),
						E('div', { 'class': 'cbi-value-field' }, [
							sstpCheck = E('input', { 'id': 'se-sstp', 'type': 'checkbox', 'checked': !!openvpn.EnableSSTP_bool }),
							E('div', { 'class': 'cbi-value-description' }, _('通过 SoftEther 的 HTTPS 监听端口连接，客户端需信任服务端证书。'))
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': 'se-openvpn-download' }, _('OpenVPN 客户端模板')),
						E('div', { 'class': 'cbi-value-field' }, [
							downloadButton = E('button', {
								'id': 'se-openvpn-download', 'type': 'button', 'class': 'cbi-button cbi-button-action',
								'disabled': !openvpn.EnableOpenVPN_bool,
								'click': function() {
									downloadButton.disabled = true;
									return callMakeOpenVPNConfig().then(rpcResult).then(result => {
										const binary = atob(result.Buffer_bin || '');
										if (!binary.startsWith('PK\x03\x04'))
											throw new Error(_('服务端未返回有效的 OpenVPN ZIP 配置包。'));
										const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
										const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
										const link = E('a', { 'href': url, 'download': 'openvpn_config.zip', 'hidden': true });
										document.body.appendChild(link);
										link.click();
										link.remove();
										setTimeout(() => URL.revokeObjectURL(url), 1000);
									}).catch(error => {
										ui.addNotification(null, E('p', {}, _('下载 OpenVPN 模板失败：') + error.message));
									}).finally(() => { downloadButton.disabled = !openvpn.EnableOpenVPN_bool; });
								}
							}, _('下载 OpenVPN 模板 (.zip)')),
							E('div', { 'class': 'cbi-value-description' }, _('先启用 OpenVPN 并保存设置。下载包包含 TUN/TAP 模板和证书。导入前检查 remote 地址和端口，多 HUB 登录用“用户名@HUB名”。'))
						])
					])
				])
			]),

			E('div', { 'class': 'cbi-page-actions' }, [
				saveButton = E('button', {
					'type': 'button', 'class': 'cbi-button cbi-button-apply', 'disabled': errors.length > 0,
					'click': function() {
						const ports = portInput.value.trim();
						if (!/^\d+(?:[ ,]+\d+)*$/.test(ports) || ports.split(/[ ,]+/).some(port => Number(port) < 1 || Number(port) > 65535)) {
							ui.addNotification(null, E('p', {}, _('请输入 1–65535 范围的端口，多个端口用逗号或空格隔开。')));
							return;
						}
						const wantedIPsec = [l2tpCheck.checked, pskInput.value.trim() || 'vpn', defaultHubSelect.value, rawL2tpCheck.checked, etheripCheck.checked];
						const wantedOpenVPN = [ovpnCheck.checked, ports, sstpCheck.checked];
						saveButton.disabled = true;
						downloadButton.disabled = true;
						ui.showModal(_('保存中...'), [E('p', { 'class': 'spinning' }, _('正在应用协议设置并读取服务端状态...'))]);
						return Promise.allSettled([
							callSetIPsec(...wantedIPsec).then(rpcResult),
							callSetOpenVPN(...wantedOpenVPN).then(rpcResult)
						]).then(writes => Promise.all([
							callGetIPsec().then(rpcResult), callGetOpenVPN().then(rpcResult)
						]).then(fresh => ({ fresh, writeError: writes.find(result => result.status === 'rejected')?.reason })))
						.then(({ fresh: [freshIPsec, freshOpenVPN], writeError }) => {
							Object.assign(ipsec, freshIPsec);
							Object.assign(openvpn, freshOpenVPN);
							l2tpCheck.checked = !!ipsec.L2TP_IPsec_bool;
							rawL2tpCheck.checked = !!ipsec.L2TP_Raw_bool;
							etheripCheck.checked = !!ipsec.EtherIP_IPsec_bool;
							pskInput.value = ipsec.IPsec_Secret_str;
							defaultHubSelect.value = ipsec.L2TP_DefaultHub_str;
							ovpnCheck.checked = !!openvpn.EnableOpenVPN_bool;
							portInput.value = openvpn.OpenVPNPortList_str;
							sstpCheck.checked = !!openvpn.EnableSSTP_bool;
							if (writeError) throw writeError;
							if (l2tpCheck.checked !== wantedIPsec[0] || rawL2tpCheck.checked !== wantedIPsec[3] || etheripCheck.checked !== wantedIPsec[4] ||
								pskInput.value !== wantedIPsec[1] || defaultHubSelect.value !== wantedIPsec[2] ||
								ovpnCheck.checked !== wantedOpenVPN[0] || sstpCheck.checked !== wantedOpenVPN[2] || normalizePorts(portInput.value) !== normalizePorts(ports))
								throw new Error(_('服务端未应用全部设置，页面已显示读取到的实际状态。'));
							ui.addNotification(null, E('p', {}, _('VPN 协议设置已保存，并已读取服务端确认。')), 'info');
						}).catch(error => {
							ui.addNotification(null, E('p', {}, _('更新协议设置失败：') + error.message + _(' 部分设置可能已生效，请刷新页面核对。')));
						}).finally(() => {
							ui.hideModal();
							saveButton.disabled = false;
							downloadButton.disabled = !openvpn.EnableOpenVPN_bool;
						});
					}
				}, _('保存并应用设置'))
			])
		]);

		return viewNode;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
