import { createFileRoute } from '@tanstack/react-router';

import { TaskDetailPane } from './_components/-task-detail-pane';

function TaskDetailRoute() {
  const { taskId } = Route.useParams();
  return <TaskDetailPane taskId={taskId} density="full" />;
}

export const Route = createFileRoute('/tasks/$taskId')({
  component: TaskDetailRoute,
});
