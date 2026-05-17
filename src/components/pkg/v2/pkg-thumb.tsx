// Pkg row thumbnail · 88×54 with the same semantics as the artifact:
// - real screenshot for UI pkgs
// - identity-hashed tinted empty placeholder with icon inside for non-UI pkgs
//
// The bytes for installed-pkg screenshots come from the `pkg_screenshot`
// Tauri command (base64 data URL, cached per pkg+path). Registry pkgs get a
// hosted https:// URL directly from the registry index. Loading state is
// invisible: we render the empty placeholder until the data URL resolves.

import { useQuery } from '@tanstack/react-query';
import { Bolt, Box, Cog, Package, Workflow } from 'lucide-react';
import { pkgScreenshot } from '@/lib/tauri-cmd';
import { cn } from '@/components/ui/utils';
import type { PkgRowV2, PkgScreenshotRef } from '@/lib/pkgs/use-derived';

/** Resolve one screenshot ref to a usable `src` URL. Cached indefinitely. */
export function useScreenshotSrc(ref: PkgScreenshotRef | null): string | null {
	const isFetch = ref?.kind === 'installed-pkg';
	const q = useQuery({
		enabled: isFetch,
		queryKey: ['pkg', 'screenshot', isFetch ? ref.pkgId : '', isFetch ? ref.path : ''],
		queryFn: () => (isFetch ? pkgScreenshot(ref.pkgId, ref.path) : Promise.resolve('')),
		staleTime: Infinity,
		gcTime: Infinity,
	});
	if (!ref) return null;
	if (ref.kind === 'url') return ref.src;
	return q.data ?? null;
}

/**
 * Deterministic hue from the pkg id so identical pkgs always look the same
 * but distinct pkgs read as distinct. We use a small mood palette (warm,
 * teal, gold, coral, plum, sage) instead of full random hues — keeps the
 * empty-state thumbs from clashing with the workspace theme.
 */
export interface TintColors {
	bg: string;
	ring: string;
	fg: string;
}

export const TINT_PALETTE: TintColors[] = [
	// Each tile lays a tinted radial gradient over a neutral surface so the
	// icon stays legible across both light + dark modes.
	{ bg: 'hsl(20 55% 14%)', ring: 'hsl(20 55% 28%)', fg: 'hsl(20 70% 70%)' }, // warm
	{ bg: 'hsl(170 35% 12%)', ring: 'hsl(170 35% 26%)', fg: 'hsl(170 50% 64%)' }, // teal
	{ bg: 'hsl(42 45% 13%)', ring: 'hsl(42 50% 28%)', fg: 'hsl(42 80% 65%)' }, // gold
	{ bg: 'hsl(8 55% 14%)', ring: 'hsl(8 55% 28%)', fg: 'hsl(8 70% 68%)' }, // coral
	{ bg: 'hsl(280 30% 14%)', ring: 'hsl(280 35% 28%)', fg: 'hsl(280 45% 70%)' }, // plum
	{ bg: 'hsl(140 26% 12%)', ring: 'hsl(140 30% 24%)', fg: 'hsl(140 38% 60%)' }, // sage
];

export function tintFor(id: string): TintColors {
	let hash = 0;
	for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
	return TINT_PALETTE[Math.abs(hash) % TINT_PALETTE.length];
}

export function iconForKind(kind: string) {
	if (kind === 'engine') return Bolt;
	if (kind === 'mcp') return Workflow;
	if (kind === 'skill') return Cog;
	if (kind === 'embedded') return Box;
	return Package;
}

export function PkgThumb({ row, size = 'md' }: { row: PkgRowV2; size?: 'sm' | 'md' }) {
	const dims =
		size === 'sm'
			? { wrapper: 'h-[38px] w-[60px]', icon: 'h-4 w-4' }
			: { wrapper: 'h-[54px] w-[88px]', icon: 'h-5 w-5' };
	const first = row.screenshots[0] ?? null;
	const src = useScreenshotSrc(first);
	const count = row.screenshots.length;

	if (!src) {
		const tint = tintFor(row.id);
		const Icon = iconForKind(row.kind);
		return (
			<div
				className={cn(
					'relative grid place-items-center overflow-hidden rounded-sm border',
					dims.wrapper
				)}
				style={{
					background: `radial-gradient(120% 120% at 30% 20%, ${tint.ring} 0%, transparent 60%), ${tint.bg}`,
					borderColor: tint.ring,
					color: tint.fg,
				}}
				title={count ? 'Loading…' : 'No screenshot — pkg has no UI'}
			>
				<Icon className={dims.icon} strokeWidth={1.5} />
			</div>
		);
	}
	return (
		<div
			className={cn(
				'relative overflow-hidden rounded-sm border border-border bg-background bg-cover bg-center transition-transform duration-150',
				'group-hover:scale-[1.04] group-hover:shadow-md',
				dims.wrapper
			)}
			style={{ backgroundImage: `url(${src})` }}
		>
			{count > 1 && (
				<span className="absolute bottom-[3px] right-1 rounded-[3px] bg-black/60 px-1 py-px font-mono text-[9px] leading-none text-white/85">
					{count}
				</span>
			)}
		</div>
	);
}
