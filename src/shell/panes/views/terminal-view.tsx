import { SingleTerminal } from '@/terminal/single-terminal';

interface TerminalViewProps {
	sessionId: string;
}

export function TerminalView({ sessionId }: TerminalViewProps) {
	return (
		<div className="h-full w-full">
			<SingleTerminal sessionId={sessionId} />
		</div>
	);
}
