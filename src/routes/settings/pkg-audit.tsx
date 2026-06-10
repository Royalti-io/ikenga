// Settings → Packages → Violations audit (ADR-017 / WP-08).
// Lists recent pkg_permission_violations across all installed pkgs.
import { createFileRoute } from '@tanstack/react-router';
import { PkgViolationsAudit } from '@/components/pkg/v2/pkg-violations-audit';

export const Route = createFileRoute('/settings/pkg-audit')({
	component: PkgViolationsAudit,
});
