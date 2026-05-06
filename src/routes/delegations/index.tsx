import { createFileRoute } from '@tanstack/react-router';

/**
 * /delegations index — list rendered by parent layout (delegations/route.tsx).
 */
function DelegationsIndexPage() {
  return null;
}

export const Route = createFileRoute('/delegations/')({
  component: DelegationsIndexPage,
});
