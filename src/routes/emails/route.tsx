import { createFileRoute, Outlet } from '@tanstack/react-router';
import { SectionTabs, type SectionTabItem } from '@/shell/section-tabs';

const EMAILS_TABS: SectionTabItem[] = [
  { to: '/emails', label: 'All emails', exact: true },
  { to: '/emails/drafts', label: 'Reply drafts' },
];

export const Route = createFileRoute('/emails')({
  component: EmailsLayout,
});

function EmailsLayout() {
  return (
    <div className="flex h-full flex-col">
      <SectionTabs items={EMAILS_TABS} />
      <div className="flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}
