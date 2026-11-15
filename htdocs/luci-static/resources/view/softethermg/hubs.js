'use strict';
'require view';
'require rpc';
'require ui';

const callEnumHubs = rpc.declare({
	object: 'luci.softethermg',
	method: 'enum_hubs',
	expect: { '': {} }
});

const callCreateHub = rpc.declare({
	object: 'luci.softethermg',
	method: 'create_hub',
	params: ['hub', 'password', 'online']
});

const callDeleteHub = rpc.declare({
	object: 'luci.softethermg',
	method: 'delete_hub',
	params: ['hub']
});

const callSetHubOnline = rpc.declare({
	object: 'luci.softethermg',
	method: 'set_hub_online',
	params: ['hub', 'online']
});

function formatBytes(bytes) {
	if (!bytes || isNaN(bytes) || bytes === 0) return '0 B';
	const k = 1024;
	const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

return view.extend({
	load: function() {
		return callEnumHubs();
	},

	render: function(res) {
		const hubs = res.result?.HubList || [];

		const tableRows = hubs.map(h => {
			const isOnline = h.Online_bool;
			const totalBytes = (h['Ex.Recv.BroadcastBytes_u64'] || 0) + (h['Ex.Send.BroadcastBytes_u64'] || 0) +
				(h['Ex.Recv.UnicastBytes_u64'] || 0) + (h['Ex.Send.UnicastBytes_u64'] || 0);

			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td', 'style': 'font-family:monospace; font-weight:600;' }, h.HubName_str),
				E('td', { 'class': 'td' }, [
					isOnline
						? E('span', { 'style': 'display:inline-flex; align-items:center; gap:4px; font-weight:500; color:#10b981;' }, [
							E('span', { 'style': 'width:6px; height:6px; border-radius:50%; background:#10b981; display:inline-block;' }),
							_('Online')
						])
						: E('span', { 'style': 'color:#9ca3af;' }, _('Offline'))
				]),
				E('td', { 'class': 'td', 'style': 'font-family:monospace; font-variant-numeric:tabular-nums;' }, h.NumUsers_u32 ?? 0),
				E('td', { 'class': 'td', 'style': 'font-family:monospace; font-variant-numeric:tabular-nums;' }, h.NumSessions_u32 ?? 0),
				E('td', { 'class': 'td', 'style': 'font-family:monospace; font-variant-numeric:tabular-nums;' }, formatBytes(totalBytes)),
				E('td', { 'class': 'td cbi-section-actions' }, [
					E('button', {
						'class': 'cbi-button cbi-button-action',
						'style': 'margin-right: 5px;',
						'click': () => {
							ui.showModal(_('切换状态中...'), [E('p', { 'class': 'spinning' }, _('正在更新 HUB 状态...'))]);
							callSetHubOnline(h.HubName_str, !isOnline).then(() => {
								ui.hideModal();
								location.reload();
							}).catch(err => {
								ui.addNotification(null, E('p', {}, _('操作失败: ') + (err.message || err)));
							});
						}
					}, isOnline ? _('下线') : _('上线')),

					E('button', {
						'class': 'cbi-button cbi-button-remove',
						'click': () => {
							if (confirm(_('确定删除虚拟 HUB "%s" 吗？此操作不可逆！').format(h.HubName_str))) {
								ui.showModal(_('删除中...'), [E('p', { 'class': 'spinning' }, _('正在删除虚拟 HUB...'))]);
								callDeleteHub(h.HubName_str).then(() => {
									ui.hideModal();
									location.reload();
								}).catch(err => {
									ui.addNotification(null, E('p', {}, _('删除失败: ') + (err.message || err)));
								});
							}
						}
					}, _('删除'))
				])
			]);
		});

		const viewNode = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('虚拟 HUB 管理')),
			E('div', { 'class': 'cbi-map-descr' }, _('虚拟 HUB 类似于虚拟交换机，每个虚拟 HUB 拥有独立的用户数据库、安全策略与网络通信域。')),

			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'cbi-section-node' }, [
					E('table', { 'class': 'table cbi-section-table' }, [
						E('tr', { 'class': 'tr table-titles' }, [
							E('th', { 'class': 'th' }, _('HUB 名称')),
							E('th', { 'class': 'th' }, _('运行状态')),
							E('th', { 'class': 'th' }, _('注册用户数')),
							E('th', { 'class': 'th' }, _('当前会话')),
							E('th', { 'class': 'th' }, _('总数据交换量')),
							E('th', { 'class': 'th cbi-section-actions' }, _('操作'))
						]),
						tableRows.length > 0 ? tableRows : E('tr', { 'class': 'tr' }, [
							E('td', { 'class': 'td', 'colspan': 6, 'style': 'text-align:center;' }, _('暂无虚拟 HUB 或无法连接服务端'))
						])
					]),
					E('div', { 'class': 'cbi-section-create' }, [
						E('button', {
							'class': 'cbi-button cbi-button-add',
							'click': function() {
								let hubNameInput, passInput, onlineInput;

								ui.showModal(_('创建虚拟 HUB'), [
									E('div', { 'class': 'cbi-section' }, [
										E('div', { 'class': 'cbi-value' }, [
											E('label', { 'class': 'cbi-value-title' }, _('HUB 名称')),
											E('div', { 'class': 'cbi-value-field' }, [
												hubNameInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'placeholder': 'VPN' })
											])
										]),
										E('div', { 'class': 'cbi-value' }, [
											E('label', { 'class': 'cbi-value-title' }, _('HUB 管理员密码')),
											E('div', { 'class': 'cbi-value-field' }, [
												passInput = E('input', { 'type': 'password', 'class': 'cbi-input-password', 'placeholder': _('选填') })
											])
										]),
										E('div', { 'class': 'cbi-value' }, [
											E('label', { 'class': 'cbi-value-title' }, _('默认上线')),
											E('div', { 'class': 'cbi-value-field' }, [
												onlineInput = E('input', { 'type': 'checkbox', 'checked': 'checked' })
											])
										])
									]),
									E('div', { 'class': 'right' }, [
										E('button', {
											'class': 'cbi-button cbi-button-neutral',
											'click': ui.hideModal
										}, _('取消')),
										' ',
										E('button', {
											'class': 'cbi-button cbi-button-positive',
											'click': function() {
												const hubName = hubNameInput.value.trim();
												if (!hubName) {
													alert(_('HUB 名称不能为空！'));
													return;
												}
												ui.showModal(_('创建中...'), [E('p', { 'class': 'spinning' }, _('正在创建虚拟 HUB...'))]);
												callCreateHub(hubName, passInput.value, onlineInput.checked).then(() => {
													ui.hideModal();
													location.reload();
												}).catch(err => {
													ui.hideModal();
													ui.addNotification(null, E('p', {}, _('创建失败: ') + (err.message || err)));
												});
											}
										}, _('确认创建'))
									])
								]);
							}
						}, _('新建虚拟 HUB'))
					])
				])
			])
		]);

		return viewNode;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
