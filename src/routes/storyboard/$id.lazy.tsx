import { createLazyFileRoute } from "@tanstack/react-router";

import { StoryboardEditor } from "@/storyboard/editor";

export const Route = createLazyFileRoute("/storyboard/$id")({
  component: StoryboardRoute,
});

function StoryboardRoute() {
  const { id } = Route.useParams();
  return <StoryboardEditor id={id} />;
}
