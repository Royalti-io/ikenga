import { createFileRoute, Outlet } from '@tanstack/react-router';
import { Wallet } from 'lucide-react';
import { SectionTabs, type SectionTabItem } from '@/shell/section-tabs';
import { EntitySwitcher } from '@/components/accounting/entity-switcher';

const FINANCE_TABS: SectionTabItem[] = [
  { to: '/finance', label: 'Overview', exact: true },
  { to: '/finance/transactions', label: 'Transactions' },
  { to: '/finance/receivables', label: 'Receivables' },
  { to: '/finance/inter-company', label: 'Inter-Company' },
  { to: '/finance/reports', label: 'Reports' },
];

export const Route = createFileRoute('/finance')({
  component: FinanceLayout,
});

function FinanceLayout() {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
        <div>
          <div className="flex items-center gap-2">
            <Wallet className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">Accounting</h1>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Cash position, transactions, receivables, and inter-company tracking.
          </p>
        </div>
        <EntitySwitcher />
      </header>
      <SectionTabs items={FINANCE_TABS} />
      <div className="flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}
