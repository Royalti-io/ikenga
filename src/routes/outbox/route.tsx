import { Outlet, createFileRoute } from '@tanstack/react-router';
import './outbox.css';

export const Route = createFileRoute('/outbox')({
  component: OutboxLayout,
});

// /outbox is a pass-through layout. Channels live in the sidebar; views
// (Queue/Schedule/Sent) are inner tabs inside each channel.
function OutboxLayout() {
  return (
    <div className="ob-page" data-workspace-scope="outbox">
      <Outlet />
    </div>
  );
}
