import { createFileRoute } from '@tanstack/react-router';

import { PkgKernelStatus } from '@/components/pkg/pkg-kernel-status';

export const Route = createFileRoute('/pkg-kernel-status')({
  component: PkgKernelStatusRoute,
});

function PkgKernelStatusRoute() {
  return (
    <div className="p-4">
      <h1 className="mb-3 text-lg font-semibold">Pkg kernel — supervised sidecars</h1>
      <PkgKernelStatus />
    </div>
  );
}
