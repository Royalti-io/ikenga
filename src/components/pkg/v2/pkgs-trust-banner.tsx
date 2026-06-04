// Page-level banner that only renders when there's something pending.

import { AlertTriangle } from 'lucide-react';
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
		<div className="flex items-center gap-3 border-b border-destructive/30 bg-destructive/10 px-6 py-2 text-sm text-destructive">
			<AlertTriangle className="h-4 w-4 shrink-0" />
			<span>{bits.join(' · ')}</span>
			<span className="flex-1" />
			{onReview && (
				<Button
					size="sm"
					variant="outline"
					className="h-7 border-destructive/40 text-destructive hover:bg-destructive/15"
					onClick={onReview}
				>
					Review →
				</Button>
			)}
		</div>
	);
}
