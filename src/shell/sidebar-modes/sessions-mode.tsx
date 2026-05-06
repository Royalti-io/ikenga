import { SquareTerminal } from 'lucide-react';

export function SessionsMode() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <SquareTerminal className="mb-3 h-8 w-8 text-muted-foreground/60" />
      <div className="text-sm font-medium text-foreground">No active sessions</div>
      <div className="mt-1 text-xs text-muted-foreground">
        Lands in <span className="font-medium text-foreground">Phase 3</span> — Claude
        Code session integration.
      </div>
      <div className="mt-3 text-[11px] text-muted-foreground">
        Will list active runs, recent threads, and resume actions.
      </div>
    </div>
  );
}
