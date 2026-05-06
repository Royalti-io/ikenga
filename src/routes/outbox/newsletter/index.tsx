import { createFileRoute, redirect } from '@tanstack/react-router';
import { supabase } from '@/lib/supabase';

// Smart-landing: query email_drafts once, route to the most useful view.
// - >= 1 ready-to-approve newsletter draft  → /queue
// - only cooling drafts (none ready yet)    → /queue?focus=cooling
// - no pending drafts                       → /schedule
// - on the 1st or last business day of mo.  → /sent?view=charts (override)
//
// Charts override is computed before the DB lookup since it doesn't depend
// on draft state.
export const Route = createFileRoute('/outbox/newsletter/')({
  beforeLoad: async () => {
    if (isChartsDay(new Date())) {
      throw redirect({
        to: '/outbox/newsletter/sent',
        search: { view: 'charts' as const },
      });
    }

    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .from('email_drafts')
      .select('id, status, reviewable_after')
      .in('type', ['newsletter', 'investor_update'])
      .in('status', ['draft', 'pending_review']);

    if (error) {
      // Fall through to queue on error so the user sees something actionable.
      throw redirect({ to: '/outbox/newsletter/queue' });
    }

    const rows = data ?? [];
    const ready = rows.filter(
      (r) => !r.reviewable_after || r.reviewable_after <= nowIso,
    );
    const cooling = rows.filter(
      (r) => r.reviewable_after && r.reviewable_after > nowIso,
    );

    if (ready.length > 0) {
      throw redirect({ to: '/outbox/newsletter/queue' });
    }
    if (cooling.length > 0) {
      throw redirect({
        to: '/outbox/newsletter/queue',
        search: { focus: 'cooling' as const },
      });
    }
    throw redirect({ to: '/outbox/newsletter/schedule' });
  },
});

function isChartsDay(d: Date): boolean {
  if (d.getDate() === 1) return true;
  // Last business day of month: walk back from the last day skipping weekends.
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  let candidate = new Date(lastDay);
  while (candidate.getDay() === 0 || candidate.getDay() === 6) {
    candidate.setDate(candidate.getDate() - 1);
  }
  return d.getDate() === candidate.getDate();
}
