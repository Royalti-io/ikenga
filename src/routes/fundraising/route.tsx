import { createFileRoute, Outlet } from '@tanstack/react-router';
import { SectionTabs, type SectionTabItem } from '@/shell/section-tabs';

const FUNDRAISING_TABS: SectionTabItem[] = [
  { to: '/fundraising', label: 'Pipeline', exact: true },
  { to: '/fundraising/analytics', label: 'Analytics' },
  { to: '/fundraising/approvals', label: 'Approvals' },
];

export const Route = createFileRoute('/fundraising')({
  component: FundraisingLayout,
});

function FundraisingLayout() {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-6 py-4">
        <h1 className="text-2xl font-bold text-foreground">Fundraising Pipeline</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Track investor conversations from research to close
        </p>
      </div>
      <SectionTabs items={FUNDRAISING_TABS} />
      <div className="flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}
