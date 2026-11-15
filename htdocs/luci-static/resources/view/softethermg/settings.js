'use strict';
'require view';
'require form';
'require rpc';
'require ui';

const callChangePass = rpc.declare({
	object: 'luci.softethermg',
	method: 'change_admin_password',
	params: ['password']
});

return view.extend({
	render: function() {
		const m = new form.Map('softethermg', _('SoftEther VPN 服务器设置'),
			_('在此配置可视化面板的连接参数。本插件既可作为已运行实例的纯管理面板，也可托管启动 SoftEther 守护进程。'));

		const s = m.section(form.NamedSection, 'global', 'global', _('基本运行设置'));
		s.anonymous = true;

		// 运行模式：纯面板 vs 进程接管
		let o = s.option(form.ListValue, 'manage_service', _('运行模式'),
			_('选择插件的角色。如果您系统上已经运行了 SoftEther VPN，请保持默认的“仅作为可视化管理面板”。'));
		o.value('0', _('仅作为可视化面板 (推荐，连接已有服务)'));
		o.value('1', _('由插件托管启动 vpnserver 进程'));
		o.default = '0';
		o.rmempty = false;

		// 通信引擎模式：vpncmd 命令行 vs JSON-RPC
		o = s.option(form.ListValue, 'api_type', _('管理通信方式'),
			_('选择与 SoftEther 服务端交互的底层通道。'));
		o.value('vpncmd', _('vpncmd 官方命令行 (推荐，免开 WebAPI 与 TLS 证书)'));
		o.value('rpc', _('JSON-RPC 2.0 WebAPI (通过 HTTPS 5555 端口)'));
		o.default = 'vpncmd';
		o.rmempty = false;

		// vpncmd 路径
		o = s.option(form.Value, 'vpncmd_path', _('vpncmd 可执行文件路径'),
			_('系统上 vpncmd 程序的完整路径。默认自动探测（如 /usr/libexec/softethervpn/vpncmd）。'));
		o.default = '/usr/libexec/softethervpn/vpncmd';
		o.depends('api_type', 'vpncmd');
		o.rmempty = true;

		// 启用服务开关
		o = s.option(form.Flag, 'enabled', _('启用面板功能'),
			_('是否启用本面板与后台的连接。'));
		o.default = '1';
		o.rmempty = false;

		// API 监听主机
		o = s.option(form.Value, 'api_host', _('服务端连接地址'),
			_('SoftEther 管理目标主机地址，本地默认为 127.0.0.1。'));
		o.datatype = 'ip4addr';
		o.default = '127.0.0.1';
		o.rmempty = false;

		// API 监听端口
		o = s.option(form.Value, 'api_port', _('服务端管理端口'),
			_('SoftEther 管理端口，默认通常为 5555。'));
		o.datatype = 'port';
		o.default = '5555';
		o.rmempty = false;

		// 管理员密码
		o = s.option(form.Value, 'admin_password', _('管理员密码'),
			_('您当前已运行的 SoftEther 服务端的管理员密码。如果之前尚未设置，可先留空连接后在下方修改。'));
		o.password = true;
		o.rmempty = true;

		// 修改服务端主管理员密码的专用操作卡片
		const secPass = m.section(form.NamedSection, 'global', 'global', _('修改 SoftEther 服务器管理员密码'));
		secPass.anonymous = true;

		o = secPass.option(form.Button, '_changepass', _('修改主密码'));
		o.inputtitle = _('更改服务端密码');
		o.inputstyle = 'apply';
		o.onclick = function() {
			const p1 = prompt(_('请输入新的 SoftEther 服务器管理员密码:'));
			if (!p1) return;
			const p2 = prompt(_('请再次输入新密码确认:'));
			if (p1 !== p2) {
				alert(_('两次输入的密码不一致！'));
				return;
			}

			ui.showModal(_('修改中...'), [E('p', { 'class': 'spinning' }, _('正在向 SoftEther 服务器更新密码...'))]);
			callChangePass(p1).then(res => {
				ui.hideModal();
				if (res.error) {
					ui.addNotification(null, E('p', {}, _('修改失败: ') + res.error.message));
				} else {
					alert(_('密码修改成功，且已自动同步至面板配置！'));
					location.reload();
				}
			}).catch(err => {
				ui.hideModal();
				ui.addNotification(null, E('p', {}, _('操作异常: ') + (err.message || err)));
			});
		};

		return m.render();
	}
});
