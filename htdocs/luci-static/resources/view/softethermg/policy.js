'use strict';
'require baseclass';
'require rpc';
'require ui';

const callGet = rpc.declare({ object: 'luci.softethermg', method: 'get_policy', params: ['kind', 'hub', 'name'], expect: { '': {} } });
const callSet = rpc.declare({ object: 'luci.softethermg', method: 'set_policy', params: ['kind', 'hub', 'name', 'enabled', 'values'], expect: { '': {} } });

function result(response) {
	if (response?.error) throw new Error(response.error.message || _('策略操作失败'));
	if (!response?.result) throw new Error(_('服务端未返回有效策略。'));
	return response.result;
}

function checkState(state) {
	if (typeof state.enabled !== 'boolean' || !state.fields || !state.values || !Array.isArray(state.supported))
		throw new Error(_('服务端未返回完整策略，无法编辑。'));
	return state;
}

return baseclass.extend({
	open: function(kind, hub, name, onSaved) {
		const request = {};
		this.activeRequest = request;
		const alive = () => this.activeRequest === request;
		const close = () => { if (alive()) { this.activeRequest = null; ui.hideModal(); } };
		const title = (kind === 'user' ? _('用户安全策略：') : _('用户组安全策略：')) + name;
		const load = () => callGet(kind, hub, name).then(result).then(checkState);

		const show = (state, message = '') => {
			if (!alive()) return;
			const controls = new Map();
			const supported = new Set(state.supported);
			const enabled = E('input', { id: 'se-policy-enabled', type: 'checkbox', checked: state.enabled });
			const errorNode = E('p', { role: 'alert' }, message);
			const cancel = E('button', { type: 'button', 'class': 'cbi-button', click: close }, _('取消'));
			let busy = false;
			const lock = (pending, valid = true) => {
				busy = pending;
				enabled.disabled = pending || !valid;
				cancel.disabled = pending;
				save.disabled = pending || !valid;
				for (const [key, control] of controls) control.disabled = pending || !valid || !enabled.checked || !supported.has(key);
			};
			enabled.addEventListener('change', () => lock(busy));
			const save = E('button', { type: 'button', 'class': 'cbi-button cbi-button-positive', click: async () => {
				if (busy) return;
				const patch = {};
				try {
					if (enabled.checked) for (const [key, control] of controls) {
						if (!supported.has(key)) continue;
						const definition = state.fields[key];
						const next = definition.type === 'bool' ? control.checked : Number(control.value);
						const initial = state.values[key] ?? definition.default;
						if (next === initial) continue;
						if (definition.type !== 'bool' && (!control.value.trim() || !Number.isInteger(next) || next < definition.min || next > definition.max))
							throw new Error(_('请检查策略数值：') + _(definition.label) + ` (${definition.min}–${definition.max})`);
						patch[key] = next;
					}
					if (enabled.checked === state.enabled && !Object.keys(patch).length) { close(); return; }
				} catch (error) { errorNode.textContent = error.message; return; }
				lock(true); errorNode.textContent = _('正在应用并读取服务端实际策略...');
				try {
					await callSet(kind, hub, name, enabled.checked, JSON.stringify(patch)).then(result);
					const fresh = await load();
					if (fresh.enabled !== enabled.checked || Object.entries(patch).some(([key, value]) => fresh.values[key] !== value))
						throw new Error(_('服务端未应用全部修改，页面将显示实际策略。'));
					if (alive()) {
						close();
						ui.addNotification(null, E('p', {}, _('安全策略已保存，并已读取服务端确认。')), 'info');
						if (onSaved) await onSaved();
					}
				} catch (error) {
					if (!alive()) return;
					try { show(await load(), error.message + _(' 当前显示服务端实际策略。')); }
					catch (readError) { errorNode.textContent = error.message + _(' 无法读取实际状态，请关闭后重新打开策略编辑器。'); lock(false, false); }
				}
			} }, _('保存策略'));

			const groups = new Map();
			for (const [key, definition] of Object.entries(state.fields)) {
				const initial = state.values[key] ?? definition.default;
				const control = E('input', { id: 'se-policy-' + key, type: definition.type === 'bool' ? 'checkbox' : 'number',
					...(definition.type === 'bool' ? { checked: !!initial } : { value: String(initial), min: definition.min, max: definition.max, step: 1, 'class': 'cbi-input-text' }) });
				controls.set(key, control);
				const row = E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title', 'for': control.id }, _(definition.label)),
					E('div', { 'class': 'cbi-value-field' }, [control, E('div', { 'class': 'cbi-value-description' },
						_(definition.help) + (supported.has(key) ? '' : _(' 当前服务端未返回此项，保存时保留原状。')))])
				]);
				if (!groups.has(definition.group)) groups.set(definition.group, []);
				groups.get(definition.group).push(row);
			}
			const source = state.enabled ? _('当前使用独立策略。') : state.source === 'group' ? _('当前继承用户组策略：') + state.group : _('当前使用默认策略。');
			ui.showModal(title, [
				E('p', {}, _('虚拟 HUB：') + hub), E('p', {}, source),
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title', 'for': enabled.id }, _('应用独立安全策略')),
					E('div', { 'class': 'cbi-value-field' }, [enabled])
				]),
				E('p', {}, kind === 'user'
					? _('启用时以当前有效值建立独立策略，之后整份策略独立维护。关闭后移除独立策略，恢复用户组或默认策略。')
					: _('关闭后移除用户组策略，未设置独立策略的成员使用默认策略。')),
				...(!state.atomic ? [E('p', {}, _('当前通信方式分步写入，失败可能部分生效，以回读为准。首次建立独立策略会先暂停新登录，核对成功后再按“允许登录”设置放行。'))] : []),
				errorNode,
				...Array.from(groups, ([group, rows], index) => E('details', { open: index < 2 }, [
					E('summary', {}, _(group)), E('fieldset', { 'class': 'cbi-section' }, rows)
				])),
				E('div', { 'class': 'right' }, [cancel, ' ', save])
			]);
			lock(false);
		};

		ui.showModal(title, [E('p', { 'class': 'spinning' }, _('正在读取策略和继承关系...')),
			E('div', { 'class': 'right' }, E('button', { type: 'button', 'class': 'cbi-button', click: close }, _('取消')))]);
		return load().then(state => show(state)).catch(error => {
			if (alive()) { close(); ui.addNotification(null, E('p', {}, _('读取策略失败：') + error.message)); }
		});
	}
});
