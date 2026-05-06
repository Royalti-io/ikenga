import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/emails/$id')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/mail/$id', params: { id: params.id } });
  },
});
