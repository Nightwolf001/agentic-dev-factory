import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register } from 'claude-code';

import type { SettingRow, Tab } from '../types/settings-pane';

// /dev-factory-settings (and /dev-factory:settings) opens this pane: every dev-factory setting with its value and where it comes from,
// changed in place. It reads and writes only through the dev-factory command line (`settings list --json`,
// `settings set`, `settings reset`), so validation, required servers and the sync to Claude stay in one place.

const PANE = 'dev-factory-settings';
const rows = atom({ plugin: 'dev-factory', key: 'rows' } as const, [] as SettingRow[], { shape: 'rows-1' });
const tab = atom({ plugin: 'dev-factory', key: 'tab' } as const, 'servers' as Tab);
const query = atom({ plugin: 'dev-factory', key: 'query' } as const, '');
const group = atom({ plugin: 'dev-factory', key: 'group' } as const, 'all');
const selected = atom({ plugin: 'dev-factory', key: 'selected' } as const, '');
const message = atom({ plugin: 'dev-factory', key: 'message' } as const, '');
const busy = atom({ plugin: 'dev-factory', key: 'busy' } as const, false);

// the launcher dev-factory install writes; it runs the newest installed plugin
const LAUNCHER = ['/bin/sh', '-c', 'exec "$HOME/.dev-factory/bin/dev-factory" "$@"', 'dev-factory'];

const TABS: { id: Tab; label: string }[] = [
	{ id: 'servers', label: 'Servers & plugins' },
	{ id: 'secrets', label: 'Secrets' },
	{ id: 'options', label: 'Options' },
];
const SCOPE_LABEL: Record<string, string> = { user: 'all projects', project: 'this project', off: 'off', 'off here': 'off here' };

const show = (r: SettingRow): string => {
	if (r.kind === 'mcp' || r.kind === 'plugin') return SCOPE_LABEL[String(r.value)] ?? String(r.value);
	if (r.kind === 'secret') return String(r.value);
	if (r.value === null || r.value === undefined) return '—';
	if (Array.isArray(r.value)) return r.value.join(', ') || '—';
	if (typeof r.value === 'object') return JSON.stringify(r.value);
	return String(r.value);
};
const editText = (r: SettingRow): string => {
	if (r.value === null || r.value === undefined) return '';
	if (Array.isArray(r.value)) return r.value.join(', ');
	if (typeof r.value === 'object') return JSON.stringify(r.value);
	return String(r.value);
};
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s.padEnd(n));
const inTab = (r: SettingRow, t: Tab) => (t === 'servers' ? r.kind === 'mcp' || r.kind === 'plugin' : t === 'secrets' ? r.kind === 'secret' : r.kind === 'option');

function cli($: EngineInterface, args: string[], stdin?: string) {
	return $.process.run([...LAUNCHER, ...args], { stdin, timeoutMs: 120_000 });
}

async function load($: EngineInterface) {
	await update($, busy, () => true);
	try {
		const r = await cli($, ['settings', 'list', '--json']);
		if (r.exitCode === 0) await update($, rows, () => JSON.parse(r.stdout) as SettingRow[]);
		else await update($, message, () => (r.stderr || r.stdout).trim().split('\n').pop() || 'could not read the settings');
	} catch (err) {
		await update($, message, () => `could not run ~/.dev-factory/bin/dev-factory (run dev-factory install --apply once): ${String((err as Error)?.message ?? err)}`);
	}
	await update($, busy, () => false);
}

async function apply($: EngineInterface, args: string[], stdin?: string) {
	await update($, busy, () => true);
	try {
		const r = await cli($, args, stdin);
		const said = `${r.stdout}\n${r.stderr}`
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean);
		await update($, message, () => (said.length ? said.slice(-3).join(' · ') : r.exitCode === 0 ? 'saved' : 'refused'));
	} catch (err) {
		await update($, message, () => String((err as Error)?.message ?? err));
	}
	await load($);
}

async function openPane($: EngineInterface) {
	await update($, message, () => '');
	await $.ui.open({ id: PANE, title: 'dev-factory settings', focus: true, closeOnEscape: true });
	void load($);
	return { text: 'dev-factory settings opened. Esc closes it.' };
}

export const register: Register = (on) => {
	on('session.start', async ($, e, next) => {
		await $.command.register({ name: 'dev-factory-settings', description: 'Open the dev-factory settings: servers, plugins, secrets and every option' });
		return next(e);
	});

	on('command.run', { command: 'dev-factory-settings' }, ($) => openPane($));
	// commands/settings.md declares /dev-factory:settings for every Claude Code; where this module loads, the pane answers it
	on('command.run', { command: 'dev-factory:settings' }, ($) => openPane($));

	on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
		const { Box, Text, Button, Input, Select } = $.ui.resolve(e);
		const width = Math.max(60, (e.props as { bodyColumns?: number })?.bodyColumns ?? e.viewport?.columns ?? 100);
		const height = e.viewport?.rows ?? 30;
		const all = await read($, rows);
		const t = await read($, tab);
		const q = (await read($, query)).toLowerCase();
		const g = await read($, group);
		const sel = await read($, selected);
		const msg = await read($, message);
		const working = await read($, busy);

		const groups = [...new Set(all.filter((r) => r.kind === 'option').map((r) => r.group))];
		const list = all.filter(
			(r) => inTab(r, t) && (t !== 'options' || g === 'all' || r.group === g) && (!q || `${r.id} ${r.title} ${r.group}`.toLowerCase().includes(q)),
		);
		const room = Math.max(4, height - 20);
		const idW = Math.min(36, Math.max(14, ...list.map((r) => r.id.length + 2)));
		const valW = Math.max(12, Math.min(32, width - idW - 24));
		const current = all.find((r) => r.id === sel);

		const detail = (r: SettingRow) => {
			if (!r.editable)
				return <Text dimColor>Set by {r.source}: change it in your shell or ~/.dev-factory/.env.local.</Text>;
			if (r.kind === 'mcp' || r.kind === 'plugin') {
				const opts = [
					{ value: 'user', label: 'All projects' },
					{ value: 'project', label: 'This project' },
					...(r.locked ? [] : [{ value: 'off', label: 'Off' }]),
					{ value: 'default', label: 'Default' },
				];
				return (
					<Box flexDirection="column">
						{r.locked && <Text dimColor>Required: it can move between scopes but cannot be turned off.</Text>}
						<Select
							key={`scope:${r.id}`}
							label="On for "
							options={opts}
							value={['user', 'project'].includes(String(r.value)) ? String(r.value) : r.locked ? 'user' : 'off'}
							onSelect={(v) => void apply($, ['settings', 'set', r.id, v])}
						/>
					</Box>
				);
			}
			if (r.kind === 'secret')
				return (
					<Input
						key={`secret:${r.id}`}
						label="New value "
						placeholder="paste it, Enter saves it to ~/.dev-factory/.env.local"
						value=""
						submitLabel="Save"
						onSubmit={(v) => {
							if (v) void apply($, ['settings', 'set', `secret:${r.id}`], v);
						}}
					/>
				);
			const reset = (
				<Button key={`reset:${r.id}`} onPress={() => void apply($, ['settings', 'reset', r.id])}>
					Back to default
				</Button>
			);
			if (r.type === 'boolean')
				return (
					<Box flexDirection="row" gap={2}>
						<Select
							key={`bool:${r.id}`}
							label="Value "
							options={[
								{ value: 'true', label: 'true' },
								{ value: 'false', label: 'false' },
							]}
							value={r.value === true ? 'true' : 'false'}
							onSelect={(v) => void apply($, ['settings', 'set', r.id, v])}
						/>
						{reset}
					</Box>
				);
			return (
				<Box flexDirection="column">
					<Input
						key={`edit:${r.id}`}
						label="Value "
						placeholder={r.type === 'list' ? 'comma-separated' : r.type === 'map' ? 'JSON' : ''}
						value={editText(r)}
						submitLabel="Save"
						onSubmit={(v) => void apply($, ['settings', 'set', r.id, v])}
					/>
					<Box flexDirection="row" gap={2}>
						<Text dimColor>Enter saves it where this setting usually lives ({r.id.startsWith('models.') || r.id.startsWith('runtime.') ? 'all projects' : 'this project'})</Text>
						{reset}
					</Box>
				</Box>
			);
		};

		return (
			<Box flexDirection="column" paddingX={1}>
				<Box flexDirection="row" gap={1}>
					{TABS.map((x) => (
						<Button
							key={`tab:${x.id}`}
							variant={x.id === t ? 'primary' : undefined}
							onPress={() => {
								void update($, tab, () => x.id);
								void update($, selected, () => '');
							}}
						>
							{x.label}
						</Button>
					))}
					{working && <Text dimColor> working…</Text>}
				</Box>
				<Input key="search" placeholder="Search settings…" value={q} onInput={(v) => void update($, query, () => v)} onSubmit={(v) => void update($, query, () => v)} />
				{t === 'options' && groups.length > 0 && (
					<Select
						key="group"
						label="Group "
						options={[{ value: 'all', label: 'All groups' }, ...groups.map((x) => ({ value: x, label: x }))]}
						value={g}
						onSelect={(v) => void update($, group, () => v)}
					/>
				)}
				<Box flexDirection="column" marginTop={1}>
					{all.length === 0 && <Text dimColor>{working ? 'Reading the settings…' : 'No settings read yet.'}</Text>}
					{list.slice(0, room).map((r) => (
						<Button key={`row:${r.id}`} plain onPress={() => void update($, selected, () => r.id)}>
							{r.id === sel ? '› ' : '  '}
							{cut(r.id, idW)}
							{cut(show(r), valW)}
							<Text dimColor>
								{' '}
								{r.locked ? 'required · ' : ''}
								{r.source}
							</Text>
						</Button>
					))}
					{list.length > room && <Text dimColor>  {list.length - room} more: refine the search</Text>}
				</Box>
				{current && inTab(current, t) && (
					<Box flexDirection="column" borderStyle="round" paddingX={1} marginTop={1}>
						<Text bold>{current.id}</Text>
						<Text dimColor>
							{current.title} · {current.group} · from {current.source}
						</Text>
						{detail(current)}
					</Box>
				)}
				{msg !== '' && <Text>{msg}</Text>}
				<Text dimColor>Tab and arrows move · Enter picks · changes save at once and sync Claude · Esc closes</Text>
			</Box>
		);
	});
};
