// The values the settings pane (hooks/settings-pane.tsx) keeps for the session, read by `claude plugin validate`.
export type SettingRow = {
	group: string;
	kind: 'mcp' | 'plugin' | 'secret' | 'option';
	id: string;
	title: string;
	type: string;
	value: unknown;
	source: string;
	locked: boolean;
	editable: boolean;
};

export type Tab = 'servers' | 'secrets' | 'options';

declare module 'claude-code' {
	interface PluginState {
		'dev-factory': {
			rows: Shaped<SettingRow[]>;
			tab: Tab;
			query: string;
			group: string;
			selected: string;
			message: string;
			busy: boolean;
		};
	}
}
