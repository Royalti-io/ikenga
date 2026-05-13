import { useEffect } from 'react';
import {
	Folder,
	LayoutGrid,
	Monitor,
	Moon,
	Package,
	Pin as PinGlyph,
	Settings,
	SquareTerminal,
	Sun,
	type LucideIcon,
} from 'lucide-react';
import { useShellStore, type ActivityMode, type CoreMode } from '@/lib/shell/shell-store';
import { usePaneStore } from '@/lib/panes/pane-store';
import { useIkengaStore, type IkengaMode, type IkengaWorkspace } from '@/lib/ikenga/theme-store';
import { cn } from '@/components/ui/utils';
import { useActivityBarPins, usePinsStore, type Pin } from '@/lib/shell/pins-store';
import { useUpdatesAvailable } from '@/lib/registry/use-updates-available';
import { PinIcon } from './pin-icon';

interface CoreItem {
	mode: CoreMode;
	label: string;
	Icon: LucideIcon;
	shortcut: string;
}

// Post-strip: 3 top + Settings. App pkgs no longer claim rail icons.
// These are the **Registered** items, sourced from nav-config / pkg
// manifests. Pinned items render in their own section below.
const CORE_TOP: CoreItem[] = [
	{ mode: 'app', label: 'App', Icon: LayoutGrid, shortcut: '⌘1' },
	{ mode: 'files', label: 'Files', Icon: Folder, shortcut: '⌘2' },
	{ mode: 'sessions', label: 'Sessions', Icon: SquareTerminal, shortcut: '⌘3' },
];

// Packages sits above Settings — it's a system-level surface (registry,
// updates, install state), not a per-workspace entry like the top rail.
const CORE_BOTTOM: CoreItem[] = [
	{ mode: 'pkgs', label: 'Packages', Icon: Package, shortcut: '⌘4' },
	{ mode: 'settings', label: 'Settings', Icon: Settings, shortcut: '⌘,' },
];

const SHORTCUT_MAP: Record<string, ActivityMode> = {
	'1': 'app',
	'2': 'files',
	'3': 'sessions',
	'4': 'pkgs',
	',': 'settings',
};

/** Landing route per mode — used by ⌘N shortcut + click. Settings + Packages
 *  navigate the focused pane; App / Files / Sessions reuse whatever the user
 *  last looked at in that mode (handled by tab-workspace state). */
const MODE_LANDING: Partial<Record<ActivityMode, string>> = {
	settings: '/settings/appearance',
	pkgs: '/packages/browse',
};

// Workspace tint mirrors core mode 1:1 post-strip; no mini-app rollup.
function modeToWorkspace(mode: ActivityMode): IkengaWorkspace {
	return mode;
}

export function ActivityBar() {
	const activeMode = useShellStore((s) => s.activeMode);
	const setActiveMode = useShellStore((s) => s.setActiveMode);
	const setWorkspace = useIkengaStore((s) => s.setWorkspace);
	const hydratePins = usePinsStore((s) => s.hydrate);
	const { sections, pinsBySection, sectionLessPins, hydrated } = useActivityBarPins();

	// Hydrate user pins on first mount. Idempotent — store guards against
	// re-runs and concurrent hydrate calls.
	useEffect(() => {
		void hydratePins();
	}, [hydratePins]);

	// Mirror activeMode → ikenga.workspace so the data-workspace attribute on
	// <html> drives all the workspace-tint variables.
	useEffect(() => {
		setWorkspace(modeToWorkspace(activeMode));
	}, [activeMode, setWorkspace]);

	const updatesAvailable = useUpdatesAvailable();

	function handleSelectMode(mode: ActivityMode) {
		setActiveMode(mode);
		const landing = MODE_LANDING[mode];
		if (landing) {
			usePaneStore.getState().navigateFocused(landing);
		}
	}

	function handleSelectPin(pin: Pin) {
		// v0: route + pkg-route navigate the focused pane; artifact / file /
		// external are not yet wired through here. The viewer + open-in-pane
		// flows for those land alongside the pin entry-point work.
		if (pin.kind === 'route' || pin.kind === 'pkg-route') {
			usePaneStore.getState().navigateFocused(pin.target);
		}
	}

	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			const mod = e.metaKey || e.ctrlKey;
			if (!mod || e.shiftKey || e.altKey) return;
			const target = e.target as HTMLElement | null;
			if (target?.matches('input, textarea, [contenteditable="true"]')) return;
			const next = SHORTCUT_MAP[e.key];
			if (!next) return;
			e.preventDefault();
			setActiveMode(next);
			const landing = MODE_LANDING[next];
			if (landing) {
				usePaneStore.getState().navigateFocused(landing);
			}
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [setActiveMode]);

	const hasAnyPins =
		hydrated &&
		(sectionLessPins.length > 0 ||
			Array.from(pinsBySection.values()).some((list) => list.length > 0));

	return (
		<nav
			aria-label="Activity bar"
			className="flex h-full w-14 shrink-0 flex-col items-center border-r border-border-soft py-3"
			style={{ background: 'var(--bg-base)' }}
		>
			{/* Registered: pkg / nav-config items. Pinned items live below the
          divider so pkg updates and uninstalls don't clobber user pins. */}
			<div className="flex flex-col items-center">
				{CORE_TOP.map((item) => (
					<RailButton
						key={item.mode}
						mode={item.mode}
						label={item.label}
						Icon={item.Icon}
						shortcut={item.shortcut}
						isActive={activeMode === item.mode}
						onSelect={handleSelectMode}
						badgeCount={0}
					/>
				))}
			</div>

			{hasAnyPins && (
				<>
					<div
						className="my-2 h-px w-6 shrink-0"
						style={{ background: 'var(--border-soft)' }}
						aria-hidden="true"
					/>
					<div className="flex flex-col items-center gap-1 overflow-y-auto">
						{sections.map((section) => {
							const list = pinsBySection.get(section.id) ?? [];
							if (list.length === 0) return null;
							return (
								<div
									key={section.id}
									className="flex flex-col items-center"
									data-section={section.id}
									title={section.label}
								>
									{list.map((pin) => (
										<PinButton key={pin.id} pin={pin} onSelect={handleSelectPin} />
									))}
								</div>
							);
						})}
						{sectionLessPins.length > 0 && (
							<div className="flex flex-col items-center" data-section="__none" title="Other">
								{sectionLessPins.map((pin) => (
									<PinButton key={pin.id} pin={pin} onSelect={handleSelectPin} />
								))}
							</div>
						)}
					</div>
				</>
			)}

			<div className="mt-auto" />

			<ThemeToggleButton />

			{CORE_BOTTOM.map((item) => (
				<RailButton
					key={item.mode}
					mode={item.mode}
					label={item.label}
					Icon={item.Icon}
					shortcut={item.shortcut}
					isActive={activeMode === item.mode}
					onSelect={handleSelectMode}
					badgeCount={item.mode === 'pkgs' ? updatesAvailable : 0}
				/>
			))}
		</nav>
	);
}

interface RailButtonProps {
	mode: ActivityMode;
	label: string;
	Icon: LucideIcon;
	shortcut: string;
	isActive: boolean;
	onSelect: (m: ActivityMode) => void;
	/** Renders a small dot/pill in the top-right when > 0. */
	badgeCount: number;
}

function RailButton({
	mode,
	label,
	Icon,
	shortcut,
	isActive,
	onSelect,
	badgeCount,
}: RailButtonProps) {
	const ws = modeToWorkspace(mode);
	const titleSuffix = badgeCount > 0 ? ` · ${badgeCount} update${badgeCount === 1 ? '' : 's'}` : '';
	return (
		<button
			type="button"
			onClick={() => onSelect(mode)}
			title={`${label} (${shortcut})${titleSuffix}`}
			aria-label={badgeCount > 0 ? `${label} (${badgeCount} updates available)` : label}
			aria-current={isActive ? 'page' : undefined}
			data-ws={ws}
			className={cn(
				'relative my-0.5 grid h-9 w-9 place-items-center rounded-md transition-colors',
				'hover:bg-card'
			)}
			style={{
				color: isActive ? `var(--tint-${ws}-fg)` : 'var(--fg-faint)',
				background: isActive ? 'var(--bg-raised)' : undefined,
			}}
		>
			{isActive && (
				<span
					aria-hidden="true"
					className="absolute -left-0.5 top-2 bottom-2 w-0.5 rounded-r"
					style={{ background: `var(--tint-${ws}-fg)` }}
				/>
			)}
			<Icon className="h-[18px] w-[18px]" />
			{badgeCount > 0 && (
				<span
					aria-hidden="true"
					className="absolute right-1 top-1 grid h-3.5 min-w-[14px] place-items-center rounded-full bg-[var(--accent,#3b82f6)] px-1 text-[9px] font-semibold leading-none text-white"
				>
					{badgeCount > 9 ? '9+' : badgeCount}
				</span>
			)}
		</button>
	);
}

const MODE_CYCLE: Record<IkengaMode, IkengaMode> = {
	light: 'dark',
	dark: 'system',
	system: 'light',
};

const MODE_ICON: Record<IkengaMode, LucideIcon> = {
	light: Sun,
	dark: Moon,
	system: Monitor,
};

const MODE_LABEL: Record<IkengaMode, string> = {
	light: 'Light',
	dark: 'Dark',
	system: 'System',
};

function ThemeToggleButton() {
	const mode = useIkengaStore((s) => s.mode);
	const setMode = useIkengaStore((s) => s.setMode);
	const Icon = MODE_ICON[mode];
	const next = MODE_CYCLE[mode];
	return (
		<button
			type="button"
			onClick={() => setMode(next)}
			title={`Theme: ${MODE_LABEL[mode]} (click for ${MODE_LABEL[next]})`}
			aria-label={`Theme: ${MODE_LABEL[mode]}`}
			className={cn(
				'relative my-0.5 grid h-9 w-9 place-items-center rounded-md transition-colors',
				'hover:bg-card'
			)}
			style={{ color: 'var(--fg-faint)' }}
		>
			<Icon className="h-[18px] w-[18px]" />
		</button>
	);
}

interface PinButtonProps {
	pin: Pin;
	onSelect: (p: Pin) => void;
}

function PinButton({ pin, onSelect }: PinButtonProps) {
	return (
		<button
			type="button"
			onClick={() => onSelect(pin)}
			title={pin.label}
			aria-label={pin.label}
			data-pin-id={pin.id}
			data-pin-kind={pin.kind}
			className={cn(
				'relative my-0.5 grid h-9 w-9 place-items-center rounded-md transition-colors',
				'hover:bg-card'
			)}
			style={{ color: 'var(--fg-faint)' }}
		>
			<PinIcon iconLucide={pin.iconLucide} iconEmoji={pin.iconEmoji} Fallback={PinGlyph} />
		</button>
	);
}
