import { createFileRoute } from '@tanstack/react-router';

function AboutStub() {
  return (
    <div className="flex h-full items-center justify-center px-6 py-10">
      <p className="text-sm text-muted-foreground">About — coming in a later PR</p>
    </div>
  );
}

export const Route = createFileRoute('/settings/about')({
  component: AboutStub,
});
