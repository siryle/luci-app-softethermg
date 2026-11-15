'use strict';
'require view';
'require rpc';
'require ui';
'require poll';

const callGetStatus = rpc.declare({
	object: 'luci.softethermg',
	method: 'status',
	expect: { '': {} }
});

const callEnumHubs = rpc.declare({
	object: 'luci.softethermg',
	method: 'enum_hubs',
	expect: { '': {} }
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
		return Promise.all([
			callGetStatus(),
			callEnumHubs()
		]);
	},

	render: function(data) {
		const statusRes = data[0] || {};
		const hubsRes = data[1] || {};

		const isRunning = !statusRes.error && statusRes.result;
		const s = statusRes.result || {};
		const hubs = hubsRes.result?.HubList || [];
		const isConnected = isRunning || hubs.length > 0;

		const content = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('SoftEther VPN 服务管理')),
			E('div', { 'class': 'cbi-map-descr' }, _('面向 OpenWrt 的轻量级可视化面板，基于本地命令行与 JSON-RPC 直连，零常驻内存。')),

			// 状态概览卡片
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('运行状态')),
				E('div', { 'class': 'cbi-section-node' }, [
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title' }, _('服务进程状态')),
						E('div', { 'class': 'cbi-value-field' }, [
							isRunning
								? E('span', { 'style': 'display:inline-flex; align-items:center; gap:6px; font-weight:600; color:#10b981;' }, [
									E('span', { 'style': 'width:7px; height:7px; border-radius:50%; background:#10b981; display:inline-block;' }),
									_('Active (运行中 / 服务在线)')
								])
								: (hubs.length > 0
									? E('span', { 'style': 'display:inline-flex; align-items:center; gap:6px; font-weight:600; color:#f59e0b;' }, [
										E('span', { 'style': 'width:7px; height:7px; border-radius:50%; background:#f59e0b; display:inline-block;' }),
										_('在线 (已连接服务，请在【基本设置】配置管理员密码)')
									])
									: E('span', { 'style': 'display:inline-flex; align-items:center; gap:6px; font-weight:600; color:#ef4444;' }, [
										E('span', { 'style': 'width:7px; height:7px; border-radius:50%; background:#ef4444; display:inline-block;' }),
										_('未连接 (检查端口或密码)')
									]))
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title' }, _('服务端版本')),
						E('div', { 'class': 'cbi-value-field', 'style': 'font-family:monospace;' }, s.ServerVersionString_str || (isConnected ? _('未知') : '-'))
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title' }, _('构建版本信息')),
						E('div', { 'class': 'cbi-value-field', 'style': 'font-family:monospace; color:#6b7280;' }, s.ServerBuildInfoString_str || '-')
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title' }, _('虚拟 HUB 数量')),
						E('div', { 'class': 'cbi-value-field', 'style': 'font-family:monospace; font-variant-numeric:tabular-nums;' }, s.NumHub_u32 ?? hubs.length ?? 0)
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title' }, _('注册用户总数')),
						E('div', { 'class': 'cbi-value-field', 'style': 'font-family:monospace; font-variant-numeric:tabular-nums;' }, s.NumUsers_u32 ?? 0)
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title' }, _('当前在线会话')),
						E('div', { 'class': 'cbi-value-field', 'id': 'se-sessions-count', 'style': 'font-family:monospace; font-weight:600; font-variant-numeric:tabular-nums;' }, s.NumSessions_u32 ?? 0)
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title' }, _('入站接收流量 (Rx)')),
						E('div', { 'class': 'cbi-value-field', 'id': 'se-traffic-recv', 'style': 'font-family:monospace; font-variant-numeric:tabular-nums;' },
							formatBytes((s['Recv.BroadcastBytes_u64'] || 0) + (s['Recv.UnicastBytes_u64'] || 0)))
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title' }, _('出站发送流量 (Tx)')),
						E('div', { 'class': 'cbi-value-field', 'id': 'se-traffic-send', 'style': 'font-family:monospace; font-variant-numeric:tabular-nums;' },
							formatBytes((s['Send.BroadcastBytes_u64'] || 0) + (s['Send.UnicastBytes_u64'] || 0)))
					])
				])
			]),

			// 快捷操作导航
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('功能导航')),
				E('div', { 'class': 'cbi-section-node' }, [
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title' }, _('模块跳转')),
						E('div', { 'class': 'cbi-value-field' }, [
							E('a', { 'class': 'cbi-button cbi-button-action', 'href': L.url('admin/services/softethermg/hubs'), 'style': 'margin-right:8px;' }, _('虚拟 HUB')),
							E('a', { 'class': 'cbi-button cbi-button-action', 'href': L.url('admin/services/softethermg/users'), 'style': 'margin-right:8px;' }, _('用户策略')),
							E('a', { 'class': 'cbi-button cbi-button-action', 'href': L.url('admin/services/softethermg/nat'), 'style': 'margin-right:8px;' }, _('SecureNAT')),
							E('a', { 'class': 'cbi-button cbi-button-action', 'href': L.url('admin/services/softethermg/protocols'), 'style': 'margin-right:8px;' }, _('服务协议')),
							E('a', { 'class': 'cbi-button cbi-button-action', 'href': L.url('admin/services/softethermg/sessions') }, _('活跃会话'))
						])
					])
				])
			])
		]);

		// 定时轮询更新状态与流量
		poll.add(function() {
			return callGetStatus().then(function(res) {
				if (!res || !res.result) return;
				const st = res.result;
				const sessEl = document.getElementById('se-sessions-count');
				const recvEl = document.getElementById('se-traffic-recv');
				const sendEl = document.getElementById('se-traffic-send');

				if (sessEl) sessEl.textContent = st.NumSessions_u32 ?? 0;
				if (recvEl) recvEl.textContent = formatBytes((st['Recv.BroadcastBytes_u64'] || 0) + (st['Recv.UnicastBytes_u64'] || 0));
				if (sendEl) sendEl.textContent = formatBytes((st['Send.BroadcastBytes_u64'] || 0) + (st['Send.UnicastBytes_u64'] || 0));
			});
		}, 3);

		return content;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
