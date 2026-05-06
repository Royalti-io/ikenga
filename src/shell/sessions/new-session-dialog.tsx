import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useSpawnSession } from '@/lib/queries/sessions';

const FALLBACK_PROJECTS = [
  '/home/nedjamez/royalti-co',
  '/home/nedjamez/royalti-co/ikenga',
  '/home/nedjamez/royalti-co/royalti-server-v2.6',
  '/home/nedjamez/royalti-co/ikenga-desktop',
];

interface NewSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultProjects?: string[];
  /** Pre-filled prompt — used by /claude "New session" buttons that target a
   *  specific agent or run a command body. */
  presetPrompt?: string;
}

export function NewSessionDialog({
  open,
  onOpenChange,
  defaultProjects = [],
  presetPrompt,
}: NewSessionDialogProps) {
  const navigate = useNavigate();
  const spawn = useSpawnSession();

  const projects =
    defaultProjects.length > 0 ? defaultProjects : FALLBACK_PROJECTS;
  const [project, setProject] = useState<string>(projects[0] ?? '');
  const [prompt, setPrompt] = useState('');

  useEffect(() => {
    if (open) {
      setProject(projects[0] ?? '');
      setPrompt(presetPrompt ?? '');
    }
  }, [open, projects, presetPrompt]);

  function handleSpawn() {
    if (!project) return;
    spawn.mutate(
      {
        cwd: project,
        opts: {
          prompt: prompt.trim() ? prompt : undefined,
        },
      },
      {
        onSuccess: ({ sessionId }) => {
          onOpenChange(false);
          navigate({ to: '/sessions/$sessionId', params: { sessionId } });
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New Claude Session</DialogTitle>
          <DialogDescription>
            Starts <code className="font-mono text-[11px]">claude</code> in the
            chosen directory using your installed CLI configuration.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Project directory
            </span>
            <select
              value={project}
              onChange={(e) => setProject(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {projects.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Initial prompt <span className="text-muted-foreground/70">(optional)</span>
            </span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="Leave blank for an interactive REPL"
              className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
            />
          </label>

          {spawn.error instanceof Error && (
            <p className="text-xs text-destructive">{spawn.error.message}</p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSpawn}
            disabled={spawn.isPending || !project}
          >
            {spawn.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            Start session
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
