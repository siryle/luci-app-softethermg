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
	params: ['l2tp', 'psk', 'hub']
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

const callEnumHubs = rpc.declare({
	object: 'luci.softethermg',
	method: 'enum_hubs',
	expect: { '': {} }
});

return view.extend({
	load: function() {
		return Promise.all([
			callGetIPsec(),
			callGetOpenVPN(),
			callEnumHubs()
		]);
	},

	render: function(data) {
		const ipsec = data[0].result || {};
		const openvpn = data[1].result || {};
		const hubs = data[2].result?.HubList || [];

		let l2tpCheck, pskInput, defaultHubSelect, ovpnCheck, portInput, sstpCheck;

		const viewNode = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('VPN 协议与客户端接入设置')),
			E('div', { 'class': 'cbi-map-descr' }, _('SoftEther VPN 支持多种移动端及桌面端原生 VPN 协议，手机与电脑无需安装第三方客户端即可直接连接。')),

			// L2TP / IPsec
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('L2TP / IPsec 服务 (适用于 iOS、Android、macOS 及 Windows 自带客户端)')),
				E('div', { 'class': 'cbi-section-node' }, [
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title' }, _('启用 L2TP over IPsec')),
						E('div', { 'class': 'cbi-value-field' }, [
							l2tpCheck = E('input', { 'type': 'checkbox', 'checked': ipsec.L2TP_IPsec_bool ? 'checked' : null }),
							E('div', { 'class': 'cbi-value-description' }, _('主流手机系统（iOS/Android）自带的 L2TP/IPsec VPN 协议。'))
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title' }, _('IPsec 预共享密钥 (PSK)')),
						E('div', { 'class': 'cbi-value-field' }, [
							pskInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': ipsec.IPsec_Secret_str || 'vpn' }),
							E('div', { 'class': 'cbi-value-description' }, _('客户端连接时填写的预共享密钥 (Pre-Shared Key)。'))
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title' }, _('默认登录虚拟 HUB')),
						E('div', { 'class': 'cbi-value-field' }, [
							defaultHubSelect = E('select', { 'class': 'cbi-input-select' },
								hubs.map(h => E('option', { 'value': h.HubName_str, 'selected': h.HubName_str === ipsec.L2TP_DefaultHub_str ? 'selected' : null }, h.HubName_str))
							)
						])
					])
				])
			]),

			// OpenVPN & SSTP
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('OpenVPN 与 MS-SSTP 协议')),
				E('div', { 'class': 'cbi-section-node' }, [
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title' }, _('启用 OpenVPN 服务')),
						E('div', { 'class': 'cbi-value-field' }, [
							ovpnCheck = E('input', { 'type': 'checkbox', 'checked': openvpn.EnableOpenVPN_bool ? 'checked' : null })
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title' }, _('OpenVPN 监听端口列表')),
						E('div', { 'class': 'cbi-value-field' }, [
							portInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': openvpn.OpenVPNPortList_str || '1194' }),
							E('div', { 'class': 'cbi-value-description' }, _('多个端口可用逗号隔开，通常默认 UDP 1194。'))
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title' }, _('启用 MS-SSTP 协议 (Windows 自带)')),
						E('div', { 'class': 'cbi-value-field' }, [
							sstpCheck = E('input', { 'type': 'checkbox', 'checked': openvpn.EnableSSTP_bool ? 'checked' : null }),
							E('div', { 'class': 'cbi-value-description' }, _('微软标准的 SSTP 协议，走 HTTPS 443 端口，抗封锁性极佳。'))
						])
					])
				])
			]),

			E('div', { 'class': 'cbi-page-actions' }, [
				E('button', {
					'class': 'cbi-button cbi-button-apply',
					'click': function() {
						ui.showModal(_('保存中...'), [E('p', { 'class': 'spinning' }, _('正在应用协议设置...'))]);
						Promise.all([
							callSetIPsec(l2tpCheck.checked, pskInput.value.trim(), defaultHubSelect.value),
							callSetOpenVPN(ovpnCheck.checked, portInput.value.trim(), sstpCheck.checked)
						]).then(() => {
							ui.hideModal();
							alert(_('VPN 协议参数已成功更新！'));
						}).catch(err => {
							ui.hideModal();
							ui.addNotification(null, E('p', {}, _('更新协议设置失败: ') + (err.message || err)));
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
