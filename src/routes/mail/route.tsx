import { createFileRoute, Outlet } from '@tanstack/react-router';
import { Mail } from 'lucide-react';
import { SectionTabs, type SectionTabItem } from '@/shell/section-tabs';

const MAIL_TABS: SectionTabItem[] = [
  { to: '/mail/triage', label: 'Triage' },
  { to: '/mail/inbox', label: 'Inbox' },
  { to: '/mail/all', label: 'All' },
  { to: '/mail/drafts', label: 'Drafts' },
];

export const Route = createFileRoute('/mail')({
  component: MailLayout,
});

function MailLayout() {
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-6 py-4">
        <div className="flex items-center gap-2">
          <Mail className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Mail</h1>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Triage, inbox, all messages, and reply drafts.
        </p>
      </header>
      <SectionTabs items={MAIL_TABS} />
      <div className="flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}
