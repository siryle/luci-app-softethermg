'use strict';
'require view';
'require rpc';
'require ui';

const callEnumHubs = rpc.declare({
	object: 'luci.softethermg',
	method: 'enum_hubs',
	expect: { '': {} }
});

const callEnumUsers = rpc.declare({
	object: 'luci.softethermg',
	method: 'enum_users',
	params: ['hub'],
	expect: { '': {} }
});

const callAddUser = rpc.declare({
	object: 'luci.softethermg',
	method: 'add_user',
	params: ['hub', 'username', 'password', 'realname', 'note', 'expire_dt', 'max_upload', 'max_download', 'multi_logins']
});

const callDelUser = rpc.declare({
	object: 'luci.softethermg',
	method: 'del_user',
	params: ['hub', 'username']
});

const callSetUserPass = rpc.declare({
	object: 'luci.softethermg',
	method: 'set_user_pass',
	params: ['hub', 'username', 'password']
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
			callEnumUsers(this.currentHub)
		]);
	},

	render: function(data) {
		const self = this;
		const hubs = data[0].result?.HubList || [];
		const users = data[1].result?.UserList || [];

		// HUB 下拉选择器
		const hubSelect = E('select', {
			'class': 'cbi-input-select',
			'change': function() {
				self.currentHub = this.value;
				ui.showModal(_('加载中...'), [E('p', { 'class': 'spinning' }, _('正在加载用户数据...'))]);
				callEnumUsers(self.currentHub).then(res => {
					ui.hideModal();
					self.renderUserTable(res.result?.UserList || []);
				}).catch(err => {
					ui.hideModal();
					ui.addNotification(null, E('p', {}, _('获取用户列表失败: ') + (err.message || err)));
				});
			}
		}, hubs.map(h => E('option', { 'value': h.HubName_str, 'selected': h.HubName_str === self.currentHub ? 'selected' : null }, h.HubName_str)));

		const tableBody = E('tbody', { 'id': 'se-user-tbody' });

		const viewNode = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('用户与认证管理')),
			E('div', { 'class': 'cbi-map-descr' }, _('在此管理特定虚拟 HUB 中的 VPN 用户账号、密码认证及流量速率策略。')),

			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title' }, _('当前虚拟 HUB')),
					E('div', { 'class': 'cbi-value-field' }, hubSelect)
				]),

				E('div', { 'class': 'cbi-section-node' }, [
					E('table', { 'class': 'table cbi-section-table' }, [
						E('thead', {}, [
							E('tr', { 'class': 'tr table-titles' }, [
								E('th', { 'class': 'th' }, _('用户名')),
								E('th', { 'class': 'th' }, _('认证模式')),
								E('th', { 'class': 'th' }, _('真实姓名 / 备注')),
								E('th', { 'class': 'th' }, _('登录次数')),
								E('th', { 'class': 'th' }, _('总流量 (广播+单播)')),
								E('th', { 'class': 'th cbi-section-actions' }, _('操作'))
							])
						]),
						tableBody
					]),

					E('div', { 'class': 'cbi-section-create' }, [
						E('button', {
							'class': 'cbi-button cbi-button-add',
							'click': function() {
								let usernameInput, passInput, realnameInput, noteInput, maxUpInput, maxDownInput, multiInput;

								ui.showModal(_('添加 VPN 用户 (HUB: %s)').format(self.currentHub), [
									E('div', { 'class': 'cbi-section' }, [
										E('div', { 'class': 'cbi-value' }, [
											E('label', { 'class': 'cbi-value-title' }, _('用户名')),
											E('div', { 'class': 'cbi-value-field' }, [
												usernameInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'placeholder': 'vpnuser' })
											])
										]),
										E('div', { 'class': 'cbi-value' }, [
											E('label', { 'class': 'cbi-value-title' }, _('用户密码')),
											E('div', { 'class': 'cbi-value-field' }, [
												passInput = E('input', { 'type': 'password', 'class': 'cbi-input-password' })
											])
										]),
										E('div', { 'class': 'cbi-value' }, [
											E('label', { 'class': 'cbi-value-title' }, _('真实姓名')),
											E('div', { 'class': 'cbi-value-field' }, [
												realnameInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'placeholder': _('选填') })
											])
										]),
										E('div', { 'class': 'cbi-value' }, [
											E('label', { 'class': 'cbi-value-title' }, _('备注说明')),
											E('div', { 'class': 'cbi-value-field' }, [
												noteInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'placeholder': _('选填') })
											])
										]),
										E('div', { 'class': 'cbi-value' }, [
											E('label', { 'class': 'cbi-value-title' }, _('上行限速 (bps)')),
											E('div', { 'class': 'cbi-value-field' }, [
												maxUpInput = E('input', { 'type': 'number', 'class': 'cbi-input-text', 'value': '0', 'placeholder': '0 为不限' })
											])
										]),
										E('div', { 'class': 'cbi-value' }, [
											E('label', { 'class': 'cbi-value-title' }, _('下行限速 (bps)')),
											E('div', { 'class': 'cbi-value-field' }, [
												maxDownInput = E('input', { 'type': 'number', 'class': 'cbi-input-text', 'value': '0', 'placeholder': '0 为不限' })
											])
										]),
										E('div', { 'class': 'cbi-value' }, [
											E('label', { 'class': 'cbi-value-title' }, _('多点并发登录限制')),
											E('div', { 'class': 'cbi-value-field' }, [
												multiInput = E('input', { 'type': 'number', 'class': 'cbi-input-text', 'value': '0', 'placeholder': '0 为不限' })
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
												const u = usernameInput.value.trim();
												const p = passInput.value;
												if (!u || !p) {
													alert(_('用户名与密码均不能为空！'));
													return;
												}
												ui.showModal(_('添加中...'), [E('p', { 'class': 'spinning' }, _('正在创建用户...'))]);
												callAddUser(
													self.currentHub, u, p,
													realnameInput.value, noteInput.value,
													'',
													parseInt(maxUpInput.value) || 0,
													parseInt(maxDownInput.value) || 0,
													parseInt(multiInput.value) || 0
												).then(() => {
													ui.hideModal();
													callEnumUsers(self.currentHub).then(r => self.renderUserTable(r.result?.UserList || []));
												}).catch(err => {
													ui.hideModal();
													ui.addNotification(null, E('p', {}, _('创建失败: ') + (err.message || err)));
												});
											}
										}, _('确认添加'))
									])
								]);
							}
						}, _('添加新用户'))
					])
				])
			])
		]);

		this.renderUserTable = function(userList) {
			tableBody.innerHTML = '';
			if (!userList || userList.length === 0) {
				tableBody.appendChild(E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td', 'colspan': 6, 'style': 'text-align:center;' }, _('当前 HUB 暂无注册用户'))
				]));
				return;
			}

			userList.forEach(u => {
				const totalBytes = (u['Recv.BroadcastBytes_u64'] || 0) + (u['Send.BroadcastBytes_u64'] || 0) +
					(u['Recv.UnicastBytes_u64'] || 0) + (u['Send.UnicastBytes_u64'] || 0);

				const row = E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td', 'style': 'font-family:monospace; font-weight:600;' }, u.Name_str),
					E('td', { 'class': 'td' }, u.AuthType_u32 === 0 ? _('密码认证') : _('证书/Radius')),
					E('td', { 'class': 'td', 'style': 'color:#6b7280;' }, (u.Realname_utf || '-') + ' / ' + (u.Note_utf || '-')),
					E('td', { 'class': 'td', 'style': 'font-family:monospace; font-variant-numeric:tabular-nums;' }, u.NumLogin_u32 ?? 0),
					E('td', { 'class': 'td', 'style': 'font-family:monospace; font-variant-numeric:tabular-nums;' }, formatBytes(totalBytes)),
					E('td', { 'class': 'td cbi-section-actions' }, [
						E('button', {
							'class': 'cbi-button cbi-button-action',
							'style': 'margin-right:5px;',
							'click': function() {
								const newPass = prompt(_('请输入用户 %s 的新密码:').format(u.Name_str));
								if (!newPass) return;
								ui.showModal(_('更新中...'), [E('p', { 'class': 'spinning' }, _('正在修改密码...'))]);
								callSetUserPass(self.currentHub, u.Name_str, newPass).then(() => {
									ui.hideModal();
									alert(_('密码修改成功！'));
								}).catch(err => {
									ui.hideModal();
									ui.addNotification(null, E('p', {}, _('修改失败: ') + (err.message || err)));
								});
							}
						}, _('重置密码')),

						E('button', {
							'class': 'cbi-button cbi-button-remove',
							'click': function() {
								if (confirm(_('确定删除用户 %s 吗？').format(u.Name_str))) {
									ui.showModal(_('删除中...'), [E('p', { 'class': 'spinning' }, _('正在删除用户...'))]);
									callDelUser(self.currentHub, u.Name_str).then(() => {
										ui.hideModal();
										callEnumUsers(self.currentHub).then(r => self.renderUserTable(r.result?.UserList || []));
									}).catch(err => {
										ui.hideModal();
										ui.addNotification(null, E('p', {}, _('删除失败: ') + (err.message || err)));
									});
								}
							}
						}, _('删除'))
					])
				]);
				tableBody.appendChild(row);
			});
		};

		this.renderUserTable(users);
		return viewNode;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
