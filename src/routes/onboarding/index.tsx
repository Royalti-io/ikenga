// Onboarding index — handled entirely by the parent route's beforeLoad,
// which redirects to the active step. This file just exists so the file
// router emits a valid `/onboarding/` entry.

import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/onboarding/')({
	// No component — the parent `route.tsx`'s `beforeLoad` always redirects
	// away from `/onboarding/` before we get here. Keep a no-op component
	// for type-safety.
	component: () => null,
});
