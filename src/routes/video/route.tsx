import { Outlet, createFileRoute } from "@tanstack/react-router";

import { SectionTabs, type SectionTabItem } from "@/shell/section-tabs";

const VIDEO_TABS: SectionTabItem[] = [
  { to: "/video", label: "Compositions", exact: true },
  { to: "/video/queue", label: "Render queue" },
];

export const Route = createFileRoute("/video")({
  component: VideoLayout,
});

function VideoLayout() {
  return (
    <div className="flex h-full flex-col">
      <SectionTabs items={VIDEO_TABS} />
      <div className="flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}
