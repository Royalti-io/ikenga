import { Outlet, createFileRoute } from "@tanstack/react-router";

import { SectionTabs, type SectionTabItem } from "@/shell/section-tabs";

const STORYBOARD_TABS: SectionTabItem[] = [
  { to: "/storyboard", label: "Storyboards", exact: true },
];

export const Route = createFileRoute("/storyboard")({
  component: StoryboardLayout,
});

function StoryboardLayout() {
  return (
    <div className="flex h-full flex-col">
      <SectionTabs items={STORYBOARD_TABS} />
      <div className="flex-1 overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}
