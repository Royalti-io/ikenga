import { createFileRoute } from '@tanstack/react-router';
import { BarChart3 } from 'lucide-react';
import { StubPanel } from '@/shell/stub-panel';

function FundraisingAnalyticsPage() {
  return (
    <StubPanel
      title="Analytics"
      description="Pipeline funnel, outreach status, activity timeline"
      icon={BarChart3}
      reason="Depends on the recharts library (not installed in the desktop app) and /api/fundraising/analytics."
    />
  );
}

export const Route = createFileRoute('/fundraising/analytics/')({
  component: FundraisingAnalyticsPage,
});
