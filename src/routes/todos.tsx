// Todos kanban — three live columns (open / in_progress / blocked) plus a
// done disclosure. Project filter defaults to the active project; "All
// projects" returns the workspace + every project's todos via a separate
// fan-out fetch. Status mutations go through /iyke/todo/update; drag is
// deferred — v1 uses an inline status dropdown on each card.

import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
	completeTodo,
	createTodo,
	listTodos,
	updateTodo,
	type Todo,
	type TodoStatus,
} from '@/lib/iyke/memory';
import { useShellStore } from '@/lib/shell/shell-store';

type Column = { id: TodoStatus; label: string };

const ACTIVE_COLUMNS: Column[] = [
	{ id: 'open', label: 'Open' },
	{ id: 'in_progress', label: 'In progress' },
	{ id: 'blocked', label: 'Blocked' },
];

function TodosPage() {
	const projects = useShellStore((s) => s.projects);
	const activeProjectId = useShellStore((s) => s.activeProjectId);
	const [scopeFilter, setScopeFilter] = useState<string>(`project:${activeProjectId}`);
	const allScopes = scopeFilter === '__all__';

	const qc = useQueryClient();
	const queryKey = useMemo(
		() => ['project-scoped', 'todos', allScopes ? '__all__' : scopeFilter] as const,
		[allScopes, scopeFilter]
	);

	const query = useQuery({
		queryKey,
		queryFn: async (): Promise<Todo[]> => {
			if (!allScopes) {
				const res = await listTodos({ scope: scopeFilter });
				return res?.todos ?? [];
			}
			// Fan-out across the workspace + every project.
			const scopes = ['workspace', ...projects.map((p) => `project:${p.id}`)];
			const results = await Promise.all(
				scopes.map((s) => listTodos({ scope: s }).then((r) => r?.todos ?? []))
			);
			return results.flat();
		},
	});

	const todos = query.data ?? [];
	const grouped = useMemo(() => {
		const acc: Record<TodoStatus, Todo[]> = {
			open: [],
			in_progress: [],
			blocked: [],
			done: [],
			cancelled: [],
		};
		for (const t of todos) acc[t.status].push(t);
		return acc;
	}, [todos]);

	const updateMut = useMutation({
		mutationFn: async (args: { id: string; status: TodoStatus }) => {
			if (args.status === 'done') {
				await completeTodo(args.id);
			} else {
				await updateTodo({ id: args.id, status: args.status });
			}
		},
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey });
		},
	});

	return (
		<div className="flex h-full flex-col bg-background">
			<div className="border-b border-border px-4 py-3">
				<div className="flex items-baseline justify-between">
					<h1 className="text-lg font-semibold">Todos</h1>
					<select
						className="rounded border border-border bg-background px-2 py-1 font-mono text-xs"
						value={scopeFilter}
						onChange={(e) => setScopeFilter(e.target.value)}
					>
						<option value="__all__">All scopes</option>
						<option value="workspace">workspace</option>
						{projects.map((p) => (
							<option key={p.id} value={`project:${p.id}`}>
								project:{p.id}
							</option>
						))}
					</select>
				</div>
				<p className="mt-1 text-sm text-muted-foreground">
					Coordination todos shared between the user and agents in this project.
				</p>
			</div>

			{/* Composer */}
			<Composer
				disabled={allScopes}
				scope={scopeFilter}
				onCreated={() => qc.invalidateQueries({ queryKey })}
			/>

			{/* Three active columns */}
			<div className="grid flex-1 min-h-0 grid-cols-3 gap-3 overflow-hidden p-3">
				{ACTIVE_COLUMNS.map((col) => (
					<div
						key={col.id}
						className="flex min-h-0 flex-col rounded-md border border-border bg-muted/20"
					>
						<div className="flex shrink-0 items-center justify-between px-3 py-2 text-sm font-medium">
							<span>{col.label}</span>
							<span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
								{grouped[col.id].length}
							</span>
						</div>
						<div className="flex-1 space-y-2 overflow-y-auto px-2 pb-2">
							{grouped[col.id].map((t) => (
								<TodoCard
									key={t.id}
									todo={t}
									onChangeStatus={(status) => updateMut.mutate({ id: t.id, status })}
								/>
							))}
						</div>
					</div>
				))}
			</div>

			{/* Done disclosure */}
			<DoneDisclosure todos={grouped.done} />
		</div>
	);
}

function Composer(props: { disabled: boolean; scope: string; onCreated: () => void }) {
	const [title, setTitle] = useState('');
	const [body, setBody] = useState('');
	const [expanded, setExpanded] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const createMut = useMutation({
		mutationFn: () =>
			createTodo({
				scope: props.scope,
				title: title.trim(),
				body: body.trim() || undefined,
			}),
		onSuccess: () => {
			setTitle('');
			setBody('');
			setExpanded(false);
			setError(null);
			props.onCreated();
		},
		onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
	});

	if (props.disabled) {
		return (
			<div className="shrink-0 border-b border-border px-4 py-2 text-xs text-muted-foreground">
				Select a single scope to create a new todo.
			</div>
		);
	}

	return (
		<div className="shrink-0 border-b border-border px-4 py-3">
			<div className="flex gap-2">
				<Input
					placeholder="What needs doing?"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					onFocus={() => setExpanded(true)}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && !e.shiftKey && title.trim()) {
							e.preventDefault();
							createMut.mutate();
						}
					}}
				/>
				<Button onClick={() => createMut.mutate()} disabled={!title.trim() || createMut.isPending}>
					<Plus className="mr-1 h-4 w-4" />
					{createMut.isPending ? 'Adding…' : 'Add'}
				</Button>
			</div>
			{expanded && (
				<Textarea
					className="mt-2 min-h-[60px]"
					placeholder="Optional body / context"
					value={body}
					onChange={(e) => setBody(e.target.value)}
				/>
			)}
			{error && <div className="mt-1 text-xs text-destructive">{error}</div>}
		</div>
	);
}

function TodoCard(props: { todo: Todo; onChangeStatus: (s: TodoStatus) => void }) {
	const { todo } = props;
	return (
		<div className="rounded-md border border-border bg-background p-2 shadow-sm">
			<div className="text-sm font-medium">{todo.title}</div>
			{todo.body && (
				<div className="mt-1 line-clamp-3 text-xs text-muted-foreground">{todo.body}</div>
			)}
			<div className="mt-2 flex items-center justify-between text-xs">
				<div className="flex flex-wrap gap-1">
					{todo.assignee && <span className="rounded bg-muted px-1.5 py-0.5">{todo.assignee}</span>}
					{todo.tags.map((t) => (
						<span key={t} className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
							#{t}
						</span>
					))}
				</div>
				<select
					className="rounded border border-border bg-background px-1 py-0.5 text-xs"
					value={todo.status}
					onChange={(e) => props.onChangeStatus(e.target.value as TodoStatus)}
				>
					<option value="open">open</option>
					<option value="in_progress">in_progress</option>
					<option value="blocked">blocked</option>
					<option value="done">done</option>
					<option value="cancelled">cancelled</option>
				</select>
			</div>
		</div>
	);
}

function DoneDisclosure(props: { todos: Todo[] }) {
	const [open, setOpen] = useState(false);
	if (props.todos.length === 0) return null;
	return (
		<div className="shrink-0 border-t border-border">
			<button
				type="button"
				className="w-full px-4 py-2 text-left text-xs font-medium text-muted-foreground hover:bg-muted/30"
				onClick={() => setOpen((o) => !o)}
			>
				{open ? '▾' : '▸'} Done · {props.todos.length}
			</button>
			{open && (
				<div className="max-h-48 overflow-y-auto px-4 pb-3">
					<ul className="space-y-1">
						{props.todos.map((t) => (
							<li key={t.id} className="text-sm line-through opacity-60">
								{t.title}
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

export const Route = createFileRoute('/todos')({
	component: TodosPage,
});
