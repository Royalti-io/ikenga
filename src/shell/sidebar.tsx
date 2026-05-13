import { useShellStore } from '@/lib/shell/shell-store';
import { AppMode } from './sidebar-modes/app-mode';
import { FilesMode } from './sidebar-modes/files-mode';
import { SessionsMode } from './sidebar-modes/sessions-mode';
import { SettingsMode } from './sidebar-modes/settings-mode';

const CORE_TITLES = {
	app: 'Ikenga',
	files: 'Files',
	sessions: 'Sessions',
	pkgs: 'Packages',
	settings: 'Settings',
} as const;

export function Sidebar() {
	const activeMode = useShellStore((s) => s.activeMode);

	let title: string = CORE_TITLES.app;
	let body: React.ReactNode;

	switch (activeMode) {
		case 'app':
			title = CORE_TITLES.app;
			body = <AppMode />;
			break;
		case 'files':
			title = CORE_TITLES.files;
			body = <FilesMode />;
			break;
		case 'sessions':
			title = CORE_TITLES.sessions;
			body = <SessionsMode />;
			break;
		case 'pkgs':
			title = CORE_TITLES.pkgs;
			// Reuse AppMode for now — it already lists installed pkgs as a nav
			// section. A pkgs-specific sidebar (recent installs, "updates
			// available" group, registry status) can land later without
			// touching the activity-bar wiring.
			body = <AppMode />;
			break;
		case 'settings':
			title = CORE_TITLES.settings;
			body = <SettingsMode />;
			break;
		default:
			// Should be unreachable post-strip — CoreMode is a closed union of
			// 4 variants. Keeps the compiler honest if the union ever widens.
			title = CORE_TITLES.app;
			body = <AppMode />;
	}

	return (
		<div
			className="flex h-full flex-col border-r border-border bg-card"
			// Workspace-tinted gradient on the head, fading into surface (shell.css §sidebar-head).
			style={{
				// Re-resolve --tint-bg-active per workspace via the [data-workspace] attribute on <html>.
				// No JS branching needed — the var cascades.
				['--ikenga-sidebar-tint' as string]: 'var(--tint-bg-active, var(--bg-surface))',
			}}
		>
			<div
				className="flex h-12 shrink-0 items-center border-b border-border-soft px-4"
				style={{
					background:
						'linear-gradient(180deg, var(--tint-bg-active, var(--bg-surface)) 0%, var(--bg-surface) 100%)',
				}}
			>
				<span
					className="text-sm font-medium tracking-tight"
					style={{
						color: 'var(--fg)',
						fontFamily: 'var(--font-display)',
						fontSize: 'var(--text-h3)',
					}}
				>
					{title}
				</span>
			</div>
			<div className="flex-1 overflow-hidden">{body}</div>
		</div>
	);
}
