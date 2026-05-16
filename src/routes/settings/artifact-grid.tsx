import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
	type DefaultSink,
	type StackMode,
	GLOBAL_KEYS,
	setGlobalDefaultSink,
	setGlobalStackMode,
} from '@/shell/artifact-studio/grid-settings';
import { settingsGet } from '@/lib/tauri-cmd';

import { SettingGroup } from './-components/setting-group';
import { SettingRow } from './-components/setting-row';

export const Route = createFileRoute('/settings/artifact-grid')({
	component: ArtifactGridSettingsPage,
});

const ARTIFACT_GRID_GLOBAL_QK = ['settings', 'artifact-grid', 'global'] as const;

function ArtifactGridSettingsPage() {
	const qc = useQueryClient();

	const q = useQuery({
		queryKey: ARTIFACT_GRID_GLOBAL_QK,
		queryFn: async () => {
			const [sink, stack] = await Promise.all([
				settingsGet(GLOBAL_KEYS.defaultSink),
				settingsGet(GLOBAL_KEYS.stackMode),
			]);
			return {
				defaultSink: (sink === 'terminal' || sink === 'sidepane' ? sink : 'auto') as DefaultSink,
				stackMode: (stack === 'expanded' ? 'expanded' : 'collapsed') as StackMode,
			};
		},
		staleTime: 10_000,
	});

	const onSink = async (v: DefaultSink) => {
		await setGlobalDefaultSink(v);
		qc.invalidateQueries({ queryKey: ARTIFACT_GRID_GLOBAL_QK });
	};
	const onStack = async (v: StackMode) => {
		await setGlobalStackMode(v);
		qc.invalidateQueries({ queryKey: ARTIFACT_GRID_GLOBAL_QK });
	};

	const sink = q.data?.defaultSink ?? 'auto';
	const stack = q.data?.stackMode ?? 'collapsed';

	return (
		<div className="mx-auto max-w-2xl space-y-6 px-6 py-6">
			<header className="space-y-1">
				<h1 className="text-lg font-semibold text-foreground">Artifact grid</h1>
				<p className="text-sm text-muted-foreground">
					Defaults for the artifact-grid pane. Per-folder overrides live in the gear menu on each
					grid header.
				</p>
			</header>

			<SettingGroup title="Routing">
				<SettingRow
					label="Default sink"
					desc="Where pin clicks dispatch when no override is set. Auto picks the foreground claude PTY if one exists, falling back to the side-pane Chat thread."
				>
					<SegmentedSink value={sink} onChange={onSink} />
				</SettingRow>
			</SettingGroup>

			<SettingGroup title="Layout">
				<SettingRow
					label="Stack mode"
					desc="Whether variant stacks (an artifact and its sibling folder of variants) open expanded by default. Toggleable per stack at runtime."
				>
					<SegmentedStackMode value={stack} onChange={onStack} />
				</SettingRow>
			</SettingGroup>
		</div>
	);
}

function SegmentedSink({
	value,
	onChange,
}: {
	value: DefaultSink;
	onChange: (v: DefaultSink) => void;
}) {
	return (
		<div className="inline-flex overflow-hidden rounded border border-border">
			{(['auto', 'terminal', 'sidepane', 'both'] as const).map((opt) => (
				<button
					key={opt}
					type="button"
					onClick={() => onChange(opt)}
					className={
						'cursor-pointer border-r border-border px-3 py-1 text-xs capitalize last:border-r-0 ' +
						(value === opt
							? 'bg-foreground/10 text-foreground'
							: 'text-muted-foreground hover:text-foreground')
					}
				>
					{opt}
				</button>
			))}
		</div>
	);
}

function SegmentedStackMode({
	value,
	onChange,
}: {
	value: StackMode;
	onChange: (v: StackMode) => void;
}) {
	return (
		<div className="inline-flex overflow-hidden rounded border border-border">
			{(['collapsed', 'expanded'] as const).map((opt) => (
				<button
					key={opt}
					type="button"
					onClick={() => onChange(opt)}
					className={
						'cursor-pointer border-r border-border px-3 py-1 text-xs capitalize last:border-r-0 ' +
						(value === opt
							? 'bg-foreground/10 text-foreground'
							: 'text-muted-foreground hover:text-foreground')
					}
				>
					{opt}
				</button>
			))}
		</div>
	);
}
