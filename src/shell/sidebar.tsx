import { useShellStore } from '@/lib/shell/shell-store';
import { MINI_APP_BY_ID } from './mini-apps-config';
import { AppMode } from './sidebar-modes/app-mode';
import { MailMode } from './sidebar-modes/mail-mode';
import { OutboxMode } from './sidebar-modes/outbox-mode';
import { FilesMode } from './sidebar-modes/files-mode';
import { AgentsMode } from './sidebar-modes/agents-mode';
import { SessionsMode } from './sidebar-modes/sessions-mode';
import { SettingsMode } from './sidebar-modes/settings-mode';
import { MiniAppPlaceholder } from './sidebar-modes/mini-app-placeholder';
import { StudioMode } from './sidebar-modes/studio-mode';

const CORE_TITLES = {
  app: 'Ikenga',
  mail: 'Mail',
  outbox: 'Outbox',
  studio: 'Studio',
  files: 'Files',
  agents: 'Agents',
  sessions: 'Sessions',
  settings: 'Settings',
} as const;

export function Sidebar() {
  const activeMode = useShellStore((s) => s.activeMode);

  let title = 'Ikenga';
  let body: React.ReactNode;

  switch (activeMode) {
    case 'app':
      title = CORE_TITLES.app;
      body = <AppMode />;
      break;
    case 'mail':
      title = CORE_TITLES.mail;
      body = <MailMode />;
      break;
    case 'outbox':
      title = CORE_TITLES.outbox;
      body = <OutboxMode />;
      break;
    case 'studio':
      title = CORE_TITLES.studio;
      body = <StudioMode />;
      break;
    case 'files':
      title = CORE_TITLES.files;
      body = <FilesMode />;
      break;
    case 'agents':
      title = CORE_TITLES.agents;
      body = <AgentsMode />;
      break;
    case 'sessions':
      title = CORE_TITLES.sessions;
      body = <SessionsMode />;
      break;
    case 'settings':
      title = CORE_TITLES.settings;
      body = <SettingsMode />;
      break;
    default: {
      const app = MINI_APP_BY_ID[activeMode];
      if (app) {
        title = app.name;
        body = <MiniAppPlaceholder app={app} />;
      } else {
        // Stale persisted activeMode from a removed rail icon. Fall back.
        title = CORE_TITLES.app;
        body = <AppMode />;
      }
    }
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
          style={{ color: 'var(--fg)', fontFamily: 'var(--font-display)', fontSize: 'var(--text-h3)' }}
        >
          {title}
        </span>
      </div>
      <div className="flex-1 overflow-hidden">{body}</div>
    </div>
  );
}
