'use strict';
'require view';
'require rpc';
'require ui';
'require poll';

const callEnumHubs = rpc.declare({
	object: 'luci.softethermg',
	method: 'enum_hubs',
	expect: { '': {} }
});

const callEnumSessions = rpc.declare({
	object: 'luci.softethermg',
	method: 'enum_sessions',
	params: ['hub'],
	expect: { '': {} }
});

const callKillSession = rpc.declare({
	object: 'luci.softethermg',
	method: 'kill_session',
	params: ['hub', 'session']
});

function formatBytes(bytes) {
	if (!bytes || isNaN(bytes) || bytes === 0) return '0 B';
	const k = 1024;
	const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

return view.extend({
	currentHub: 'DEFAULT',

	load: function() {
		return Promise.all([
			callEnumHubs(),
			callEnumSessions(this.currentHub)
		]);
	},

	render: function(data) {
		const self = this;
		const hubs = data[0].result?.HubList || [];
		const sessions = data[1].result?.SessionList || [];

		const hubSelect = E('select', {
			'class': 'cbi-input-select',
			'change': function() {
				self.currentHub = this.value;
				callEnumSessions(self.currentHub).then(res => {
					self.renderSessionTable(res.result?.SessionList || []);
				});
			}
		}, hubs.map(h => E('option', { 'value': h.HubName_str, 'selected': h.HubName_str === self.currentHub ? 'selected' : null }, h.HubName_str)));

		const tableBody = E('tbody', { 'id': 'se-session-tbody' });

		const viewNode = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('实时在线会话监控')),
			E('div', { 'class': 'cbi-map-descr' }, _('实时监控当前连接到各个虚拟 HUB 的客户端会话、网络传输速率及 IP 地址，并可随时断开恶意或异常连接。')),

			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title' }, _('选择虚拟 HUB')),
					E('div', { 'class': 'cbi-value-field' }, hubSelect)
				]),

				E('div', { 'class': 'cbi-section-node' }, [
					E('table', { 'class': 'table cbi-section-table' }, [
						E('thead', {}, [
							E('tr', { 'class': 'tr table-titles' }, [
								E('th', { 'class': 'th' }, _('会话标识 / 用户名')),
								E('th', { 'class': 'th' }, _('客户端真实 IP')),
								E('th', { 'class': 'th' }, _('主机名 / 操作系统')),
								E('th', { 'class': 'th' }, _('TCP 连接数')),
								E('th', { 'class': 'th' }, _('已传输数据量')),
								E('th', { 'class': 'th' }, _('连接时间')),
								E('th', { 'class': 'th cbi-section-actions' }, _('操作'))
							])
						]),
						tableBody
					])
				])
			])
		]);

		this.renderSessionTable = function(sessionList) {
			tableBody.innerHTML = '';
			if (!sessionList || sessionList.length === 0) {
				tableBody.appendChild(E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td', 'colspan': 7, 'style': 'text-align:center;' }, _('当前 HUB 没有在线客户端会话'))
				]));
				return;
			}

			sessionList.forEach(s => {
				const isLink = s.LinkMode_bool || s.SecureNATMode_bool || s.BridgeMode_bool;
				const displayUser = s.Username_str || (s.SecureNATMode_bool ? _('[SecureNAT 虚拟服务]') : (s.BridgeMode_bool ? _('[网桥连接]') : _('未知')));

				const row = E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td' }, [
						E('div', { 'style': 'font-family:monospace; font-weight:600;' }, displayUser),
						E('div', { 'style': 'font-size:11px; font-family:monospace; color:#6b7280;' }, s.Name_str)
					]),
					E('td', { 'class': 'td', 'style': 'font-family:monospace;' }, s.ClientIP_ip || '-'),
					E('td', { 'class': 'td', 'style': 'color:#6b7280;' }, s.Hostname_str || '-'),
					E('td', { 'class': 'td', 'style': 'font-family:monospace; font-variant-numeric:tabular-nums;' }, s.CurrentNumTcp_u32 ?? 1),
					E('td', { 'class': 'td', 'style': 'font-family:monospace; font-variant-numeric:tabular-nums;' }, formatBytes(s.PacketSize_u64 || 0)),
					E('td', { 'class': 'td', 'style': 'font-family:monospace; font-size:11px; color:#6b7280;' }, (s.CreatedTime_dt || '').replace('T', ' ').substring(0, 19)),
					E('td', { 'class': 'td cbi-section-actions' }, [
						isLink ? E('span', { 'style': 'color:#a0aec0;' }, _('系统会话')) :
						E('button', {
							'class': 'cbi-button cbi-button-remove',
							'click': function() {
								if (confirm(_('确定强制断开会话 %s 吗？').format(displayUser))) {
									ui.showModal(_('操作中...'), [E('p', { 'class': 'spinning' }, _('正在断开客户端会话...'))]);
									callKillSession(self.currentHub, s.Name_str).then(() => {
										ui.hideModal();
										callEnumSessions(self.currentHub).then(r => self.renderSessionTable(r.result?.SessionList || []));
									}).catch(err => {
										ui.hideModal();
										ui.addNotification(null, E('p', {}, _('断开失败: ') + (err.message || err)));
									});
								}
							}
						}, _('断开连接'))
					])
				]);
				tableBody.appendChild(row);
			});
		};

		this.renderSessionTable(sessions);

		// 每 4 秒自动刷新在线会话列表
		poll.add(function() {
			return callEnumSessions(self.currentHub).then(res => {
				self.renderSessionTable(res.result?.SessionList || []);
			});
		}, 4);

		return viewNode;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
