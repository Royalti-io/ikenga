// Page-level banner that only renders when there's something pending.

import { AlertTriangle } from 'lucide-react';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import type { DerivedPkgs } from '@/lib/pkgs/use-derived';

export function PkgsTrustBanner({ d, onReview }: { d: DerivedPkgs; onReview?: () => void }) {
	const trustCount = d.trust.length;
	const violationCount = d.violations.length;
	if (!trustCount && !violationCount) return null;
	const bits: string[] = [];
	if (trustCount)
		bits.push(`${trustCount} pkg${trustCount === 1 ? ' needs' : 's need'} trust review`);
	if (violationCount)
		bits.push(`${violationCount} permission violation${violationCount === 1 ? '' : 's'}`);
	return (
		<Banner
			tone="danger"
			icon={<AlertTriangle />}
			className="px-6"
			actions={
				onReview && (
					<Button
						size="sm"
						variant="outline"
						className="h-7 border-destructive/40 text-destructive hover:bg-destructive/15"
						onClick={onReview}
					>
						Review →
					</Button>
				)
			}
		>
			{bits.join(' · ')}
		</Banner>
	);
}
