import { createFileRoute } from '@tanstack/react-router';

function TasksIndexPage() {
  return <div className="tk-empty">Select a task</div>;
}

export const Route = createFileRoute('/tasks/')({
  component: TasksIndexPage,
});
