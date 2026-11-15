'use strict';
'require view';
'require rpc';
'require ui';
'require uci';
'require view.softethermg.client as client';

const declare = (method, params = []) => rpc.declare({ object: 'luci.softethermg', method, params, expect: { '': {} } });
const callHubs = declare('enum_hubs');
const callUsers = declare('enum_users', ['hub']);
const callGroups = declare('enum_groups', ['hub']);
const callAdd = declare('add_user', ['hub', 'username', 'password', 'realname', 'note', 'expire_dt', 'max_upload', 'max_download', 'multi_logins', 'group']);
const callInfo = declare('set_user_info', ['hub', 'username', 'realname', 'note', 'group']);
const callPassword = declare('set_user_pass', ['hub', 'username', 'password']);
const callDelete = declare('del_user', ['hub', 'username']);
const callCreateGroup = declare('create_group', ['hub', 'name', 'realname', 'note']);
const callSetGroup = declare('set_group', ['hub', 'name', 'realname', 'note']);
const callDeleteGroup = declare('delete_group', ['hub', 'name']);
const authLabels = [_('匿名认证'), _('密码认证'), _('独立证书认证'), _('签名证书认证'), _('RADIUS 认证'), _('NT 域认证')];

function result(response) {
	if (response?.error) throw new Error(response.error.message || _('SoftEther 操作失败'));
	if (!response?.result) throw new Error(_('服务端未返回有效结果，请检查连接设置。'));
	return response.result;
}

function formatBytes(value) {
	const bytes = Number(value) || 0;
	if (bytes <= 0) return '0 B';
	const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
	return (bytes / Math.pow(1024, index)).toFixed(index ? 2 : 0) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][index];
}

function field(title, input, description) {
	return E('div', { 'class': 'cbi-value' }, [
		E('label', { 'class': 'cbi-value-title', 'for': input.id }, title),
		E('div', { 'class': 'cbi-value-field' }, [input, ...(description ? [E('div', { 'class': 'cbi-value-description' }, description)] : [])])
	]);
}

function input(id, value = '', type = 'text') {
	return E('input', { id: 'se-account-' + id, type, 'class': 'cbi-input-text', value });
}

return view.extend({
	currentHub: 'DEFAULT',

	load: function() {
		return Promise.all([callHubs(), uci.load('softethermg')]).then(([response]) => {
			const hubs = result(response).HubList || [];
			this.currentHub = hubs.some(h => h.HubName_str === this.currentHub) ? this.currentHub : hubs[0]?.HubName_str;
			return [response, hubs];
		}).catch(error => [{ error: { message: error.message } }, []]);
	},

	render: function(data) {
		this.hubs = data[1];
		this.users = [];
		this.groups = [];
		this.loaded = false;
		this.errorNode = E('div', { 'role': 'alert' });
		this.userBody = E('tbody');
		this.groupBody = E('tbody');
		this.search = input('search');
		this.search.setAttribute('placeholder', _('用户名、用户组、姓名或备注'));
		this.search.addEventListener('input', () => this.renderTables());
		this.hubSelect = E('select', {
			'id': 'se-account-hub', 'class': 'cbi-input-select',
			'change': () => { this.currentHub = this.hubSelect.value; return this.refresh(); }
		}, this.hubs.map(h => E('option', { value: h.HubName_str, selected: h.HubName_str === this.currentHub }, h.HubName_str)));
		this.addButton = E('button', { 'type': 'button', 'class': 'cbi-button cbi-button-add', disabled: true, click: () => this.editUser() }, _('添加用户'));
		this.groupButton = E('button', { 'type': 'button', 'class': 'cbi-button cbi-button-add', disabled: true, click: () => this.editGroup() }, _('添加用户组'));
		const table = (headers, body) => E('div', { 'style': 'overflow-x:auto;' }, [
			E('table', { 'class': 'table cbi-section-table', 'style': headers.length > 4 ? 'min-width:800px;' : 'min-width:500px;' }, [
				E('thead', {}, [E('tr', { 'class': 'tr table-titles' }, headers.map(title => E('th', { 'class': 'th' }, title)))]), body
			])
		]);
		const content = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('用户与用户组管理')),
			E('div', { 'class': 'cbi-map-descr' }, _('管理当前 HUB 的用户和用户组，分配成员，并下载 SoftEther VPN Client 的 .vpn 连接文件。')),
			this.errorNode,
			field(_('虚拟 HUB'), this.hubSelect), field(_('搜索用户'), this.search),
			E('p', {}, _('窄屏下可横向滚动表格，查看全部信息和操作。')),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('用户')), table([_('用户名'), _('认证方式'), _('用户组'), _('姓名 / 备注'), _('登录次数'), _('总流量'), _('操作')], this.userBody), this.addButton
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('用户组')), E('p', {}, _('在编辑用户时分配用户组。编辑组资料会保留已有策略；删除组会解除成员关系，保留用户账号。')),
				table([_('组名'), _('姓名 / 备注'), _('成员数'), _('操作')], this.groupBody), this.groupButton
			])
		]);
		if (data[0].error) this.errorNode.appendChild(E('p', { 'class': 'alert-message warning' }, data[0].error.message));
		else if (!this.currentHub) this.errorNode.appendChild(E('p', {}, _('请先创建虚拟 HUB，再添加用户。')));
		else this.refresh();
		return content;
	},

	refresh: function() {
		const hub = this.currentHub;
		this.loaded = false;
		this.users = []; this.groups = [];
		this.addButton.disabled = this.groupButton.disabled = this.hubSelect.disabled = true;
		this.errorNode.replaceChildren();
		this.userBody.replaceChildren(E('tr', { 'class': 'tr' }, E('td', { 'colspan': 7 }, _('正在读取用户和用户组...'))));
		this.groupBody.replaceChildren();
		return Promise.all([callUsers(hub).then(result), callGroups(hub).then(result)]).then(([users, groups]) => {
			if (this.currentHub !== hub) return;
			this.users = users.UserList || [];
			this.groups = groups.GroupList || [];
			this.loaded = true;
			this.renderTables();
		}).catch(error => {
			this.users = []; this.groups = [];
			this.userBody.replaceChildren(); this.groupBody.replaceChildren();
			this.errorNode.appendChild(E('p', { 'class': 'alert-message warning' }, error.message));
		}).finally(() => {
			this.hubSelect.disabled = false;
			this.addButton.disabled = this.groupButton.disabled = !this.loaded;
		});
	},

	renderTables: function() {
		if (!this.loaded) return;
		this.userBody.replaceChildren(); this.groupBody.replaceChildren();
		const query = this.search.value.toLocaleLowerCase();
		const users = this.users.filter(user => [user.Name_str, user.GroupName_str, user.Realname_utf, user.Note_utf].some(value => String(value || '').toLocaleLowerCase().includes(query)));
		for (const user of users) {
			const bytes = user.TrafficBytes_u64 ?? ['Recv.BroadcastBytes_u64', 'Send.BroadcastBytes_u64', 'Recv.UnicastBytes_u64', 'Send.UnicastBytes_u64'].reduce((total, key) => total + (Number(user[key]) || 0), 0);
			this.userBody.appendChild(E('tr', { 'class': 'tr' }, [
				...([user.Name_str, authLabels[user.AuthType_u32] || _('未知认证'), user.GroupName_str || '-', `${user.Realname_utf || '-'} / ${user.Note_utf || '-'}`, String(user.NumLogin_u32 || 0), formatBytes(bytes)].map(value => E('td', { 'class': 'td' }, value))),
				E('td', { 'class': 'td cbi-section-actions' }, [
					E('button', { 'type': 'button', 'class': 'cbi-button cbi-button-edit', click: () => this.editUser(user) }, _('编辑')),
					' ', E('button', { 'type': 'button', 'class': 'cbi-button cbi-button-action', click: () => this.downloadClient(user) }, _('下载 .vpn')),
					' ', E('button', { 'type': 'button', 'class': 'cbi-button cbi-button-action', click: () => this.resetPassword(user) }, _('重置密码')),
					' ', E('button', { 'type': 'button', 'class': 'cbi-button cbi-button-remove', click: event => {
						const hub = this.currentHub;
						if (confirm(_('确定删除用户 %s 吗？').format(user.Name_str)))
							return this.mutate(event.currentTarget, () => callDelete(hub, user.Name_str).then(result), false, () => !this.users.some(entry => entry.Name_str === user.Name_str));
					} }, _('删除'))
				])
			]));
		}
		if (!users.length) this.userBody.appendChild(E('tr', { 'class': 'tr' }, E('td', { 'colspan': 7 }, query ? _('没有匹配的用户') : _('当前 HUB 暂无注册用户'))));
		for (const group of this.groups) this.groupBody.appendChild(E('tr', { 'class': 'tr' }, [
			...[group.Name_str, `${group.Realname_utf || '-'} / ${group.Note_utf || '-'}`, String(group.NumUsers_u32 || 0)].map(value => E('td', { 'class': 'td' }, value)),
			E('td', { 'class': 'td cbi-section-actions' }, [
				E('button', { 'type': 'button', 'class': 'cbi-button cbi-button-edit', click: () => this.editGroup(group) }, _('编辑用户组')),
				' ', E('button', { 'type': 'button', 'class': 'cbi-button cbi-button-remove', click: event => {
					const hub = this.currentHub;
					if (confirm(_('确定删除用户组 %s 吗？成员账号会保留，并解除组成员关系。').format(group.Name_str)))
						return this.mutate(event.currentTarget, () => callDeleteGroup(hub, group.Name_str).then(result), false, () => !this.groups.some(entry => entry.Name_str === group.Name_str));
				} }, _('删除用户组'))
			])
		]));
		if (!this.groups.length) this.groupBody.appendChild(E('tr', { 'class': 'tr' }, E('td', { 'colspan': 4 }, _('当前 HUB 暂无用户组'))));
	},

	mutate: function(button, operation, closeModal = false, verify = null) {
		const hub = this.currentHub;
		button.disabled = true;
		return Promise.resolve().then(operation).then(() => this.refresh()).then(() => {
			if (!this.loaded || this.currentHub !== hub || (verify && !verify()))
				throw new Error(_('服务端未确认此次修改，请检查页面显示的实际状态后重试。'));
			if (closeModal) ui.hideModal();
		}).catch(error => ui.addNotification(null, E('p', {}, error.message))).finally(() => { button.disabled = false; });
	},

	editUser: function(user) {
		const hub = this.currentHub;
		const name = input('name', user?.Name_str || ''); name.readOnly = !!user;
		const password = input('password', '', 'password'); password.autocomplete = 'new-password';
		const realname = input('realname', user?.Realname_utf || '');
		const note = input('note', user?.Note_utf || '');
		const names = Array.from(new Set(this.groups.map(group => group.Name_str).concat(user?.GroupName_str || []).filter(Boolean)));
		const group = E('select', { 'id': 'se-account-group', 'class': 'cbi-input-select' }, [
			E('option', { value: '', selected: !user?.GroupName_str }, _('不加入用户组')),
			...names.map(value => E('option', { value, selected: value === user?.GroupName_str }, value))
		]);
		const limits = ['upload', 'download', 'logins'].map(id => {
			const control = input(id, '0', 'number'); control.min = 0; control.max = 2147483647; control.step = 1; return control;
		});
		const save = E('button', { 'type': 'button', 'class': 'cbi-button cbi-button-positive', click: () => {
			if (!name.value.trim() || (!user && !password.value)) {
				ui.addNotification(null, E('p', {}, _('用户名和密码不能为空。'))); return;
			}
			if (!user && limits.some(control => !/^\d+$/.test(control.value) || Number(control.value) > 2147483647)) {
				ui.addNotification(null, E('p', {}, _('限制值必须是 0–2147483647 范围内的整数，0 表示不限。'))); return;
			}
			return this.mutate(save, () => (user
				? callInfo(hub, user.Name_str, realname.value, note.value, group.value)
				: callAdd(hub, name.value.trim(), password.value, realname.value, note.value, '', ...limits.map(control => Number(control.value)), group.value)
			).then(result).then(() => { password.value = ''; }), true, () => this.users.some(entry =>
				entry.Name_str === name.value.trim() && (entry.GroupName_str || '') === group.value &&
				(entry.Realname_utf || '') === realname.value && (entry.Note_utf || '') === note.value && (user || entry.AuthType_u32 === 1)));
		} }, user ? _('保存用户') : _('创建用户'));
		ui.showModal(user ? _('编辑用户：') + user.Name_str : _('添加 VPN 用户'), [
			E('p', {}, _('虚拟 HUB：') + hub), field(_('用户名'), name),
			...(!user ? [field(_('密码'), password), ...limits.map((control, i) => field([_('上行限速 (bps)'), _('下行限速 (bps)'), _('并发登录数')][i], control, _('0 表示不限；没有单独设置用户策略时继承用户组策略。')))] : []),
			field(_('姓名'), realname), field(_('备注'), note), field(_('用户组'), group),
			E('div', { 'class': 'right' }, [E('button', { 'type': 'button', 'class': 'cbi-button', click: () => { password.value = ''; ui.hideModal(); } }, _('取消')), ' ', save])
		]);
	},

	editGroup: function(group) {
		const hub = this.currentHub;
		const name = input('group-name', group?.Name_str || ''); name.readOnly = !!group;
		const realname = input('group-realname', group?.Realname_utf || '');
		const note = input('group-note', group?.Note_utf || '');
		const save = E('button', { 'type': 'button', 'class': 'cbi-button cbi-button-positive', click: () => {
			if (!name.value.trim()) { ui.addNotification(null, E('p', {}, _('组名不能为空。'))); return; }
			return this.mutate(save, () => (group ? callSetGroup : callCreateGroup)(hub, name.value.trim(), realname.value, note.value).then(result), true,
				() => this.groups.some(entry => entry.Name_str === name.value.trim() && (entry.Realname_utf || '') === realname.value && (entry.Note_utf || '') === note.value));
		} }, _('保存用户组'));
		ui.showModal(group ? _('编辑用户组') : _('添加用户组'), [
			field(_('组名'), name), field(_('姓名'), realname), field(_('备注'), note),
			E('p', {}, _('已有组策略将保留。组策略的详细编辑仍需使用 SoftEther 管理工具。')),
			E('div', { 'class': 'right' }, [E('button', { 'type': 'button', 'class': 'cbi-button', click: ui.hideModal }, _('取消')), ' ', save])
		]);
	},

	resetPassword: function(user) {
		const hub = this.currentHub;
		const password = input('reset-password', '', 'password'); password.autocomplete = 'new-password';
		const save = E('button', { 'type': 'button', 'class': 'cbi-button cbi-button-positive', click: () => {
			if (!password.value) { ui.addNotification(null, E('p', {}, _('密码不能为空。'))); return; }
			return this.mutate(save, () => callPassword(hub, user.Name_str, password.value).then(result).then(() => { password.value = ''; }), true);
		} }, _('确认重置'));
		ui.showModal(_('重置密码：') + user.Name_str, [
			E('p', {}, _('此操作会将账号改为密码认证，并保留用户组、到期时间和安全策略。')),
			field(_('新密码'), password), E('div', { 'class': 'right' }, [
				E('button', { 'type': 'button', 'class': 'cbi-button', click: () => { password.value = ''; ui.hideModal(); } }, _('取消')), ' ', save
			])
		]);
	},

	downloadClient: function(user) {
		const hub = this.currentHub;
		const configured = uci.get('softethermg', 'global', 'api_host');
		const host = input('client-host', configured && !['127.0.0.1', '::1', 'localhost'].includes(configured) ? configured : location.hostname.replace(/^\[|\]$/g, ''));
		const port = input('client-port', '443', 'number'); port.min = 1; port.max = 65535;
		const account = input('client-name', `${hub} - ${user.Name_str}`);
		const embed = E('input', { id: 'se-account-embed', type: 'checkbox', disabled: ![1, 4, 5].includes(user.AuthType_u32) });
		const password = input('client-password', '', 'password'); password.disabled = true; password.autocomplete = 'off';
		embed.addEventListener('change', () => { password.disabled = !embed.checked; if (!embed.checked) password.value = ''; });
		const download = E('button', { 'type': 'button', 'class': 'cbi-button cbi-button-positive', click: () => {
			try {
				if (embed.checked && !password.value) throw new Error(_('请填写要嵌入的密码，或取消“嵌入密码”。'));
				const file = client.buildFile({ host: host.value.trim(), port: Number(port.value), hub, username: user.Name_str, authType: user.AuthType_u32, accountName: account.value, password: embed.checked ? password.value : '' });
				const url = URL.createObjectURL(new Blob([file.content], { type: 'application/octet-stream' }));
				const link = E('a', { href: url, download: file.filename, hidden: true });
				document.body.appendChild(link); link.click(); link.remove();
				setTimeout(() => URL.revokeObjectURL(url), 1000);
				password.value = ''; ui.hideModal();
			} catch (error) { ui.addNotification(null, E('p', {}, error.message)); }
		} }, _('下载 .vpn 文件'));
		ui.showModal(_('下载连接文件：') + user.Name_str, [
			E('p', {}, _('用于 SoftEther VPN Client，导入后连接当前用户。服务端地址和端口应填写客户端实际可访问的地址；导入后核对服务端证书。')),
			field(_('服务端地址'), host), field(_('端口'), port), field(_('连接名称'), account),
			field(_('嵌入密码'), embed),
			E('p', {}, _('不勾选时由客户端在连接时询问。勾选后，持有文件的人可以使用该凭据连接；RADIUS/NT 密码会以明文写入文件。')),
			field(_('密码'), password, _('密码仅在当前浏览器中生成文件，不上传或保存到路由器。证书认证需在客户端另外配置证书。')),
			E('div', { 'class': 'right' }, [E('button', { 'type': 'button', 'class': 'cbi-button', click: () => { password.value = ''; ui.hideModal(); } }, _('取消')), ' ', download])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
