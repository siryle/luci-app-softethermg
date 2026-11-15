'use strict';
'require view';
'require rpc';
'require ui';

const callEnumHubs = rpc.declare({
	object: 'luci.softethermg',
	method: 'enum_hubs',
	expect: { '': {} }
});

const callGetHubStatus = rpc.declare({
	object: 'luci.softethermg',
	method: 'get_hub_status',
	params: ['hub'],
	expect: { '': {} }
});

const callGetNat = rpc.declare({
	object: 'luci.softethermg',
	method: 'get_nat',
	params: ['hub'],
	expect: { '': {} }
});

const callSetNat = rpc.declare({
	object: 'luci.softethermg',
	method: 'set_nat',
	params: ['hub', 'use_nat', 'use_dhcp', 'ip', 'mask', 'dhcp_start', 'dhcp_end', 'dhcp_mask', 'gateway', 'dns']
});

const callToggleNat = rpc.declare({
	object: 'luci.softethermg',
	method: 'toggle_nat',
	params: ['hub', 'enable']
});

return view.extend({
	currentHub: 'DEFAULT',

	load: function() {
		return Promise.all([
			callEnumHubs(),
			callGetHubStatus(this.currentHub),
			callGetNat(this.currentHub)
		]);
	},

	render: function(data) {
		const self = this;
		const hubs = data[0].result?.HubList || [];
		const hubStatus = data[1].result || {};
		const natOpt = data[2].result || {};

		let isNatEnabled = hubStatus.SecureNATEnabled_bool || false;

		// Input fields
		let useNatCheck, useDhcpCheck, ipInput, maskInput, startInput, endInput, dhcpMaskInput, gwInput, dnsInput;

		const hubSelect = E('select', {
			'class': 'cbi-input-select',
			'change': function() {
				self.currentHub = this.value;
				ui.showModal(_('加载中...'), [E('p', { 'class': 'spinning' }, _('正在加载 SecureNAT 配置...'))]);
				Promise.all([
					callGetHubStatus(self.currentHub),
					callGetNat(self.currentHub)
				]).then(res => {
					ui.hideModal();
					location.reload();
				}).catch(err => {
					ui.hideModal();
					ui.addNotification(null, E('p', {}, _('加载失败: ') + (err.message || err)));
				});
			}
		}, hubs.map(h => E('option', { 'value': h.HubName_str, 'selected': h.HubName_str === self.currentHub ? 'selected' : null }, h.HubName_str)));

		const viewNode = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('虚拟 NAT 与 DHCP 服务 (SecureNAT)')),
			E('div', { 'class': 'cbi-map-descr' }, _('SecureNAT 为连接的 VPN 客户端提供内部虚拟路由、NAT 转发及 DHCP 地址分配，免去手动配置本地网桥和 iptables 的繁琐步骤。')),

			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title' }, _('目标虚拟 HUB')),
					E('div', { 'class': 'cbi-value-field' }, hubSelect)
				]),

				// SecureNAT 开关卡片
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title' }, _('SecureNAT 服务状态')),
					E('div', { 'class': 'cbi-value-field' }, [
						isNatEnabled
							? E('span', { 'class': 'badge', 'style': 'background-color:#48bb78; color:#fff; padding:3px 8px; border-radius:4px; margin-right:10px;' }, _('已启用'))
							: E('span', { 'class': 'badge', 'style': 'background-color:#a0aec0; color:#fff; padding:3px 8px; border-radius:4px; margin-right:10px;' }, _('已停用')),

						E('button', {
							'class': isNatEnabled ? 'cbi-button cbi-button-remove' : 'cbi-button cbi-button-action',
							'click': function() {
								ui.showModal(_('操作中...'), [E('p', { 'class': 'spinning' }, _('正在切换 SecureNAT 状态...'))]);
								callToggleNat(self.currentHub, !isNatEnabled).then(() => {
									ui.hideModal();
									location.reload();
								}).catch(err => {
									ui.hideModal();
									ui.addNotification(null, E('p', {}, _('操作失败: ') + (err.message || err)));
								});
							}
						}, isNatEnabled ? _('停用 SecureNAT') : _('启用 SecureNAT'))
					])
				])
			]),

			// 参数配置表单
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('SecureNAT 网络参数设置')),
				E('div', { 'class': 'cbi-section-node' }, [
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title' }, _('启用虚拟 NAT')),
						E('div', { 'class': 'cbi-value-field' }, [
							useNatCheck = E('input', { 'type': 'checkbox', 'checked': (natOpt.UseNat_bool !== false) ? 'checked' : null }),
							E('div', { 'class': 'cbi-value-description' }, _('允许 VPN 客户端通过路由器的外网接口访问互联网。'))
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title' }, _('启用虚拟 DHCP 服务器')),
						E('div', { 'class': 'cbi-value-field' }, [
							useDhcpCheck = E('input', { 'type': 'checkbox', 'checked': (natOpt.UseDhcp_bool !== false) ? 'checked' : null }),
							E('div', { 'class': 'cbi-value-description' }, _('自动向接入的 VPN 客户端分配 IP 地址和网关。'))
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title' }, _('虚拟路由器 IP 地址')),
						E('div', { 'class': 'cbi-value-field' }, [
							ipInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': natOpt.Ip_ip || '192.168.30.1' })
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title' }, _('子网掩码')),
						E('div', { 'class': 'cbi-value-field' }, [
							maskInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': natOpt.Mask_ip || '255.255.255.0' })
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title' }, _('DHCP 起始 IP')),
						E('div', { 'class': 'cbi-value-field' }, [
							startInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': natOpt.DhcpLeaseIPStart_ip || '192.168.30.10' })
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title' }, _('DHCP 结束 IP')),
						E('div', { 'class': 'cbi-value-field' }, [
							endInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': natOpt.DhcpLeaseIPEnd_ip || '192.168.30.200' })
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title' }, _('默认网关地址')),
						E('div', { 'class': 'cbi-value-field' }, [
							gwInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': natOpt.DhcpGatewayAddress_ip || '192.168.30.1' })
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title' }, _('主 DNS 服务器')),
						E('div', { 'class': 'cbi-value-field' }, [
							dnsInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': natOpt.DhcpDnsServerAddress_ip || '192.168.30.1' })
						])
					])
				])
			]),

			E('div', { 'class': 'cbi-page-actions' }, [
				E('button', {
					'class': 'cbi-button cbi-button-apply',
					'click': function() {
						ui.showModal(_('保存中...'), [E('p', { 'class': 'spinning' }, _('正在应用 SecureNAT 配置...'))]);
						callSetNat(
							self.currentHub,
							useNatCheck.checked,
							useDhcpCheck.checked,
							ipInput.value.trim(),
							maskInput.value.trim(),
							startInput.value.trim(),
							endInput.value.trim(),
							maskInput.value.trim(),
							gwInput.value.trim(),
							dnsInput.value.trim()
						).then(() => {
							ui.hideModal();
							alert(_('SecureNAT 配置已更新成功！'));
						}).catch(err => {
							ui.hideModal();
							ui.addNotification(null, E('p', {}, _('保存失败: ') + (err.message || err)));
						});
					}
				}, _('保存并应用配置'))
			])
		]);

		return viewNode;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
