import { SegmentedLinks, type SegmentedLinkItem } from '@/components/ui/segmented';

// Route-level sub-nav strip. A thin chrome wrapper (bottom border + padding)
// around the shared SegmentedLinks pill strip — the router-driven shape of the
// segmented-view-switcher (segmented-view-switcher.md §4). The pill vocabulary,
// aria-current, focus ring + reduced-motion guard all live in SegmentedLinks.
export type SectionTabItem = SegmentedLinkItem;

export function SectionTabs({ items }: { items: SectionTabItem[] }) {
	return (
		<div className="border-b border-border bg-background">
			<SegmentedLinks items={items} className="px-3 py-1" />
		</div>
	);
}
