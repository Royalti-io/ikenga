// Phase 5 — Manifest → connector resolver.
//
// Given a set of selected (or installed) pkgs and their manifests, this
// derives which connectors must be configured. The same function runs
// during onboarding (selected pkgs from step 4) and post-onboarding
// (installed pkgs from `pkgKernelStatus`). One resolver, two surfaces.

import {
	CONNECTOR_REGISTRY,
	type ConnectorDef,
	type ConnectorId,
	type ConnectorStatus,
	type ManifestLike,
} from './connectors';

export interface ConnectorRequirement {
	connectorId: ConnectorId;
	/** Every pkg id (from the input set) whose manifest triggers this
	 *  connector. Sorted alphabetically for stable rendering. */
	requiredBy: string[];
	/** Optional — only populated when a status was provided by the caller.
	 *  Wizard / settings card fill this from `connector.status()`. */
	currentStatus?: ConnectorStatus;
}

export interface ResolveOptions {
	/** Override the default registry (mostly for tests). */
	registry?: readonly ConnectorDef[];
}

/**
 * Walk each (manifest ∈ selected pkgs) × (connector ∈ registry) pair and
 * collect every match. Returns one `ConnectorRequirement` per connector,
 * deduplicated by `connectorId`. Connectors that aren't triggered by any
 * selected pkg are absent from the result — that's how "deselect last
 * consumer" naturally removes a substep.
 */
export function resolveRequiredConnectors(
	selectedPkgIds: ReadonlySet<string> | readonly string[],
	manifests: readonly ManifestLike[],
	opts: ResolveOptions = {}
): ConnectorRequirement[] {
	const selected = selectedPkgIds instanceof Set ? selectedPkgIds : new Set(selectedPkgIds);
	const registry = opts.registry ?? CONNECTOR_REGISTRY;
	const grouped = new Map<ConnectorId, Set<string>>();

	for (const manifest of manifests) {
		if (!selected.has(manifest.id)) continue;
		for (const connector of registry) {
			if (!manifestTriggersConnector(manifest, connector)) continue;
			const bucket = grouped.get(connector.id) ?? new Set<string>();
			bucket.add(manifest.id);
			grouped.set(connector.id, bucket);
		}
	}

	const out: ConnectorRequirement[] = [];
	for (const connector of registry) {
		const consumers = grouped.get(connector.id);
		if (!consumers || consumers.size === 0) continue;
		out.push({
			connectorId: connector.id,
			requiredBy: Array.from(consumers).sort(),
		});
	}
	return out;
}

/**
 * Decide whether a single manifest triggers a single connector. Public
 * for the resolver tests — the predicate matrix is the unit we lock down.
 */
export function manifestTriggersConnector(
	manifest: ManifestLike,
	connector: ConnectorDef
): boolean {
	const { triggers } = connector;

	if (triggers.capability) {
		const block = manifest.capabilities?.[triggers.capability];
		// `block.required === true` is the only positive signal; absent /
		// `required: false` means the pkg has a soft dependency it can
		// degrade past.
		if (block && (block as { required?: boolean }).required === true) {
			return true;
		}
	}

	if (triggers.vaultKeys && triggers.vaultKeys.length > 0) {
		const declared = manifest.permissions?.['vault.keys'] ?? [];
		const declaredSet = new Set(declared);
		const isSuperset = triggers.vaultKeys.every((k) => declaredSet.has(k));
		if (isSuperset) return true;
	}

	if (triggers.predicate?.(manifest)) {
		return true;
	}

	return false;
}

/**
 * Merge a connector status snapshot into a list of requirements. Returns a
 * fresh array — does not mutate the input. The wizard step uses this to
 * decorate the resolver output with live vault state.
 */
export function withStatuses(
	requirements: readonly ConnectorRequirement[],
	statuses: Partial<Record<ConnectorId, ConnectorStatus>>
): ConnectorRequirement[] {
	return requirements.map((r) => ({
		...r,
		currentStatus: statuses[r.connectorId] ?? r.currentStatus,
	}));
}

/**
 * Pretty-prints the requirement matrix for log output / test snapshots —
 * one line per connector listing the pkg consumers.
 */
export function formatRequirementMatrix(requirements: readonly ConnectorRequirement[]): string {
	if (requirements.length === 0) return '(no connectors required)';
	return requirements.map((r) => `${r.connectorId}: ${r.requiredBy.join(', ')}`).join('\n');
}
