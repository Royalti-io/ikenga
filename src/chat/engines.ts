/**
 * Engine catalog for the composer's two-level Engine → Model popover.
 *
 * The catalog now reflects live install state — an engine row is
 * `installed: true` only when its id is BOTH registered in the Rust
 * `EngineRegistry` (`chat_engines_list`) AND its CLI is detected on
 * PATH by `agent_detect` (and authed where the auth probe is decisive).
 *
 * `ENGINE_CATALOG_BASE` is the synchronous fallback used at boot before
 * the live queries resolve. It carries the canonical engine ids, labels,
 * model lists, and descriptions; `installed` defaults to false so we
 * don't misleadingly green-light an engine we can't yet prove is there.
 * `useEngineCatalog()` is the live, React-flavored accessor that merges
 * the base with the registry + detect intersection.
 *
 * `findEngineForModel` / `modelLabelFor` stay synchronous against the
 * base catalog so renderers (e.g. `Thread`'s provenance tag) don't need
 * to thread a hook through.
 */
import { useQuery } from '@tanstack/react-query';

import {
	chatEnginesList,
	detectAgents,
	type DetectedAgent,
} from '@/lib/tauri-cmd';

import type { ModelOption } from './adapter';

export interface EngineEntry {
	/** Stable id — used as a popover-row key, the persisted
	 *  `chat_threads.adapter` value, and the Tauri-command `engineId` arg. */
	id: string;
	/** Display label rendered in the popover group header. */
	label: string;
	/** True iff the engine is registered with the Rust dispatcher AND
	 *  detected on PATH (and authed when the auth probe is decisive).
	 *  False rows render greyed with a "not installed" tag in the popover. */
	installed: boolean;
	/** Per-engine model list. For non-installed engines this is the
	 *  marketed shape we expect when the CLI is present. */
	models: ModelOption[];
	/** Optional one-line description shown under the engine header. */
	description?: string;
	/** When `installed === false`, a short hint explaining what's missing
	 *  ("not on PATH", "not authed: …"). Surfaced as a tooltip on the row. */
	notInstalledHint?: string;
}

/** Maps engine ids to the `agent_detect` ids they correspond to. The two
 *  taxonomies differ deliberately — engine ids are the chat-layer label
 *  (`claude-code`, `gemini`, `codex`) while detect ids are the CLI-family
 *  label (`claude-code`, `gemini-cli`, `codex`). */
const DETECT_ID_FOR_ENGINE: Record<string, string> = {
	'claude-code': 'claude-code',
	gemini: 'gemini-cli',
	codex: 'codex',
};

/** Base catalog — the shape of every engine we know about, used as the
 *  synchronous fallback before the live query resolves. Order is the
 *  rendering order in the popover; installed engines float to the top in
 *  the live merge. */
export const ENGINE_CATALOG_BASE: EngineEntry[] = [
	{
		id: 'claude-code',
		label: 'Claude Code',
		installed: false,
		models: [
			{ id: 'claude-opus-4-7', label: 'Opus 4.7' },
			{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
			{ id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
		],
		description: 'Anthropic Claude via the local claude CLI.',
	},
	{
		id: 'gemini',
		label: 'Gemini',
		installed: false,
		models: [
			{ id: 'gemini-2-5-pro', label: 'Gemini 2.5 Pro' },
			{ id: 'gemini-2-5-flash', label: 'Gemini 2.5 Flash' },
		],
		description: 'Google Gemini via the gemini CLI in ACP mode.',
	},
	{
		id: 'codex',
		label: 'Codex (preview)',
		installed: false,
		models: [],
		description: 'OpenAI Codex CLI, wrapped in a PTY. Streaming only.',
	},
];

/** @deprecated — kept for renderers that only need the static shape
 *  (label, model list, description) and don't care about live install
 *  state. New UI should call `useEngineCatalog()`. */
export const ENGINE_CATALOG: EngineEntry[] = ENGINE_CATALOG_BASE;

/** Merge a base catalog with the registry + detect intersection. Pure
 *  function so it can be unit-tested without touching React. */
export function mergeEngineCatalog(
	base: EngineEntry[],
	registeredIds: string[],
	detected: DetectedAgent[]
): EngineEntry[] {
	const registered = new Set(registeredIds);
	const detectById = new Map<string, DetectedAgent>(detected.map((d) => [d.id, d]));
	const merged = base.map((entry) => {
		const isRegistered = registered.has(entry.id);
		const detectId = DETECT_ID_FOR_ENGINE[entry.id];
		const detect = detectId ? detectById.get(detectId) : undefined;
		const onPath = !!detect && !!detect.executable_path;
		// `authed === null` means we never probed — treat as installed so
		// engines without a decisive auth check (e.g. `cursor-agent`) don't
		// silently disappear. `authed === false` means we DID probe and the
		// probe was negative — surface the hint.
		const authedOk = !detect || detect.authed !== false;
		const installed = isRegistered && onPath && authedOk;
		let hint: string | undefined;
		if (!isRegistered) hint = 'not built in this shell';
		else if (!onPath) hint = 'CLI not on PATH';
		else if (!authedOk) hint = detect?.auth_hint ?? 'not authenticated';
		return {
			...entry,
			installed,
			notInstalledHint: installed ? undefined : hint,
		};
	});
	// Installed first, base order within each bucket.
	return merged
		.map((e, i) => ({ e, i }))
		.sort((a, b) => {
			if (a.e.installed === b.e.installed) return a.i - b.i;
			return a.e.installed ? -1 : 1;
		})
		.map(({ e }) => e);
}

/** React hook returning the live engine catalog. Subscribes to the
 *  registry + detect queries; the returned `data` is always usable —
 *  before the queries resolve it returns the base catalog with every
 *  engine flagged `installed: false`. */
export function useEngineCatalog(): EngineEntry[] {
	const { data: registered = [] } = useQuery({
		queryKey: ['chat-engines-list'],
		queryFn: () => chatEnginesList(),
		staleTime: 30_000,
	});
	const { data: detected = [] } = useQuery({
		queryKey: ['detect-agents'],
		queryFn: () => detectAgents(),
		staleTime: 30_000,
	});
	return mergeEngineCatalog(ENGINE_CATALOG_BASE, registered, detected);
}

/** Find which engine owns a given model id. Returns null when the
 *  model is unknown (e.g. user typed a free-form id or installed an
 *  engine pkg the static catalog doesn't list yet). Stays synchronous
 *  against the base catalog so non-React callers can use it. */
export function findEngineForModel(modelId: string | null | undefined): EngineEntry | null {
	if (!modelId) return null;
	for (const eng of ENGINE_CATALOG_BASE) {
		if (eng.models.some((m) => m.id === modelId)) return eng;
	}
	return null;
}

/** Find an engine row by its id. Falls back to the base catalog so
 *  Thread's provenance tag can resolve labels even before the live
 *  catalog has loaded. */
export function findEngineById(engineId: string | null | undefined): EngineEntry | null {
	if (!engineId) return null;
	return ENGINE_CATALOG_BASE.find((e) => e.id === engineId) ?? null;
}

/** Look up a model's display label by id. Falls back to the raw id
 *  with `claude-` stripped + hyphens turned into spaces so unknown
 *  models still render sensibly in the pill. */
export function modelLabelFor(modelId: string | null | undefined): string {
	if (!modelId) return 'Auto';
	for (const eng of ENGINE_CATALOG_BASE) {
		const hit = eng.models.find((m) => m.id === modelId);
		if (hit) return hit.label;
	}
	return modelId.replace(/^claude-/, '').replace(/-/g, ' ');
}
