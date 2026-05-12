import { createFileRoute } from '@tanstack/react-router';

import { PackagesPage } from '../packages';

export const Route = createFileRoute('/settings/packages')({
	component: PackagesPage,
});
