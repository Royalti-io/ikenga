import { createFileRoute } from '@tanstack/react-router';
import { Banknote } from 'lucide-react';
import { StubPanel } from '@/shell/stub-panel';

function FundraisingPipelinePage() {
  return (
    <StubPanel
      title="Pipeline"
      description="Fundraising kanban with deal detail + add-deal dialog"
      icon={Banknote}
      reason="Depends on FundraisingKanban / FundraisingDetail / AddDealDialog components and the /api/fundraising endpoint."
    />
  );
}

export const Route = createFileRoute('/fundraising/')({
  component: FundraisingPipelinePage,
});
