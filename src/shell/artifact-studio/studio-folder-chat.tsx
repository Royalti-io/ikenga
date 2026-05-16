// Folder-scoped chat for Studio at grid density.
//
// Phase 1 of the unified artifact-studio plan ships the persistence +
// composer plumbing only — there is no engine wiring yet. Submitting a
// message appends a 'user' row to studio_messages with a {kind:'folder'}
// scope chip; engine response/streaming lands in Phase 2 alongside scope
// re-keying for artifact / element / compare.
//
// Renders three things: the scoped thread history (scope chip per message),
// a composer that targets the current folder scope, and an empty-state for
// fresh threads.
//
// See plans/shell/2026-05-16-artifact-studio-unified.md §"Chat thread model".

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, MessageSquare, Send } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/components/ui/utils';
import {
	parseStudioScopeChip,
	type StudioMessage,
	studioMessageAppend,
	studioMessageList,
	studioThreadGetOrCreate,
} from '@/lib/tauri-cmd';

interface StudioFolderChatProps {
	folderPath: string;
	className?: string;
}

const QK_THREAD = (folderPath: string) => ['studio-thread', folderPath] as const;
const QK_MESSAGES = (threadId: string) => ['studio-messages', threadId] as const;

export function StudioFolderChat({ folderPath, className }: StudioFolderChatProps) {
	const qc = useQueryClient();

	const threadQuery = useQuery({
		queryKey: QK_THREAD(folderPath),
		queryFn: () => studioThreadGetOrCreate(folderPath),
		// The thread is durable on disk; staleness is fine but a long cache
		// avoids re-querying when the user toggles between density modes.
		staleTime: 30_000,
	});
	const threadId = threadQuery.data?.id ?? null;

	const messagesQuery = useQuery({
		queryKey: threadId ? QK_MESSAGES(threadId) : ['studio-messages', 'pending'],
		queryFn: async () => {
			if (!threadId) return [];
			return studioMessageList({ threadId });
		},
		enabled: !!threadId,
		// Append mutations invalidate this; no need to poll.
		staleTime: Number.POSITIVE_INFINITY,
	});

	const messages = messagesQuery.data ?? [];

	const send = useCallback(
		async (text: string) => {
			if (!threadId) return;
			await studioMessageAppend({
				threadId,
				role: 'user',
				contentMd: text,
				scopeChip: { kind: 'folder', target: folderPath },
			});
			await qc.invalidateQueries({ queryKey: QK_MESSAGES(threadId) });
		},
		[threadId, folderPath, qc]
	);

	if (threadQuery.isLoading) {
		return (
			<div
				className={cn(
					'flex h-full w-full items-center justify-center text-xs text-muted-foreground',
					className
				)}
			>
				<Loader2 className="mr-2 h-3 w-3 animate-spin" />
				Loading thread…
			</div>
		);
	}
	if (threadQuery.error) {
		return (
			<div
				className={cn(
					'flex h-full w-full items-center justify-center p-3 text-center text-xs text-destructive',
					className
				)}
			>
				Thread failed: {String(threadQuery.error)}
			</div>
		);
	}

	return (
		<div className={cn('flex h-full w-full flex-col', className)}>
			<div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-muted/20 px-3 py-1.5 text-[10px] text-muted-foreground">
				<MessageSquare className="h-3 w-3" />
				<span className="font-mono">scope: folder</span>
				<span className="ml-auto font-mono">
					{messages.length} {messages.length === 1 ? 'msg' : 'msgs'}
				</span>
			</div>
			<ThreadView messages={messages} folderPath={folderPath} />
			<Composer onSend={send} disabled={!threadId} />
		</div>
	);
}

interface ThreadViewProps {
	messages: StudioMessage[];
	folderPath: string;
}

function ThreadView({ messages, folderPath }: ThreadViewProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const nearBottomRef = useRef(true);

	// Track whether the user is "near the bottom" before each render. If
	// they've scrolled up to read history, don't yank them back when a new
	// message lands. Threshold = 80px — covers typical line-height + a bit
	// of jitter without making the auto-scroll feel slow.
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const onScroll = () => {
			const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
			nearBottomRef.current = dist <= 80;
		};
		el.addEventListener('scroll', onScroll, { passive: true });
		return () => el.removeEventListener('scroll', onScroll);
	}, []);

	// Auto-scroll when a new message arrives, but only if the user hadn't
	// scrolled away. Cheap — only fires when messages.length actually
	// changes.
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		if (!nearBottomRef.current) return;
		el.scrollTop = el.scrollHeight;
	}, [messages.length]);

	if (messages.length === 0) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground">
				<MessageSquare className="h-5 w-5 opacity-40" />
				<div className="max-w-[260px] leading-relaxed">
					Fresh thread for <span className="font-mono">{folderPath}</span>. Ask about anything in
					this folder — the chip travels with each message as you focus into specific artifacts.
				</div>
			</div>
		);
	}

	return (
		<div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3">
			<ul className="space-y-3">
				{messages.map((m) => (
					<MessageRow key={m.id} message={m} />
				))}
			</ul>
		</div>
	);
}

function MessageRow({ message }: { message: StudioMessage }) {
	const chip = parseStudioScopeChip(message.scopeChipJson);
	const roleClass =
		message.role === 'user'
			? 'text-foreground'
			: message.role === 'claude'
				? 'text-amber-700 dark:text-amber-400'
				: 'text-emerald-700 dark:text-emerald-400';

	return (
		<li className="flex flex-col gap-1">
			<div className="flex items-baseline gap-2 text-[9px] uppercase tracking-wider text-muted-foreground">
				<span className={cn('font-bold', roleClass)}>{message.role}</span>
				{chip ? (
					<span className="font-mono normal-case tracking-normal text-[10px]">
						<ScopeChipBadge chip={chip} />
					</span>
				) : null}
				<span className="ml-auto font-mono normal-case tracking-normal">
					{fmtTime(message.createdAt)}
				</span>
			</div>
			<div className="whitespace-pre-wrap text-xs leading-relaxed text-foreground">
				{message.contentMd}
			</div>
		</li>
	);
}

function ScopeChipBadge({ chip }: { chip: ReturnType<typeof parseStudioScopeChip> }) {
	if (!chip) return null;
	const tint =
		chip.kind === 'folder'
			? 'border-emerald-700 text-emerald-700 dark:border-emerald-400 dark:text-emerald-400'
			: chip.kind === 'artifact'
				? 'border-amber-600 text-amber-700 dark:border-amber-400 dark:text-amber-400'
				: chip.kind === 'element'
					? 'border-orange-700 text-orange-700 dark:border-orange-400 dark:text-orange-400'
					: 'border-muted-foreground text-muted-foreground';
	return (
		<span className={cn('inline-flex items-center gap-1 border px-1 py-[1px]', tint)}>
			<span className="font-bold">{chip.kind}</span>
			<span className="truncate max-w-[180px]">{chip.target}</span>
		</span>
	);
}

interface ComposerProps {
	onSend: (text: string) => Promise<void>;
	disabled: boolean;
}

function Composer({ onSend, disabled }: ComposerProps) {
	const [draft, setDraft] = useState('');
	const [sending, setSending] = useState(false);

	const submit = useCallback(async () => {
		const text = draft.trim();
		if (!text || sending) return;
		setSending(true);
		try {
			await onSend(text);
			setDraft('');
		} finally {
			setSending(false);
		}
	}, [draft, sending, onSend]);

	return (
		<div className="shrink-0 border-t border-border bg-background p-2">
			<Textarea
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter' && !e.shiftKey) {
						e.preventDefault();
						void submit();
					}
				}}
				placeholder="Ask about this folder…"
				className="min-h-[2.5rem] resize-none text-xs"
				disabled={disabled || sending}
			/>
			<div className="mt-1.5 flex items-center justify-between gap-2">
				<span className="text-[9px] text-muted-foreground">
					{sending ? 'Sending…' : 'Enter to send · Shift+Enter for newline'}
				</span>
				<Button
					size="sm"
					onClick={() => void submit()}
					disabled={disabled || sending || !draft.trim()}
					className="h-6 px-3 text-[10px]"
				>
					<Send className="mr-1 h-2.5 w-2.5" />
					Send
				</Button>
			</div>
		</div>
	);
}

function fmtTime(ms: number): string {
	const d = new Date(ms);
	return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
