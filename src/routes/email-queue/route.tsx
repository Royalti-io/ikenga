import { createFileRoute, Outlet } from '@tanstack/react-router';
import { SectionTabs, type SectionTabItem } from '@/shell/section-tabs';

const EMAIL_TABS: SectionTabItem[] = [
  { to: '/email-queue', label: 'Drafts', exact: true },
];

export const Route = createFileRoute('/email-queue')({
  component: EmailQueueLayout,
});

function EmailQueueLayout() {
  return (
    <div className="flex h-full flex-col">
      <SectionTabs items={EMAIL_TABS} />
      <div className="flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}
