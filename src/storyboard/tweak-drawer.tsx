/**
 * Beat-meta editor (label, narration excerpt, time start/end).
 * Ported from TweakDrawer.tsx but using shadcn-styled inputs.
 */

import { useEffect, useState } from "react";

import { cn } from "@/components/ui/utils";
import type { StoryboardBeat } from "@/lib/storyboard/types";

interface TweakDrawerProps {
  open: boolean;
  beat: StoryboardBeat;
  onSave: (patch: {
    label?: string;
    narration_excerpt?: string;
    timeStart?: number;
    timeEnd?: number;
  }) => void;
  onToggle: () => void;
}

export function TweakDrawer({ open, beat, onSave, onToggle }: TweakDrawerProps) {
  const [label, setLabel] = useState(beat.label);
  const [narration, setNarration] = useState(beat.narration_excerpt ?? "");
  const [start, setStart] = useState(beat.time.start);
  const [end, setEnd] = useState(beat.time.end);

  // Reset whenever the active beat changes.
  useEffect(() => {
    setLabel(beat.label);
    setNarration(beat.narration_excerpt ?? "");
    setStart(beat.time.start);
    setEnd(beat.time.end);
  }, [beat.id, beat.label, beat.narration_excerpt, beat.time.start, beat.time.end]);

  if (!open) {
    return null;
  }

  const dirty =
    label !== beat.label ||
    narration !== (beat.narration_excerpt ?? "") ||
    start !== beat.time.start ||
    end !== beat.time.end;

  const save = () => {
    if (!dirty) return;
    onSave({
      label: label !== beat.label ? label : undefined,
      narration_excerpt:
        narration !== (beat.narration_excerpt ?? "") ? narration : undefined,
      timeStart: start !== beat.time.start ? start : undefined,
      timeEnd: end !== beat.time.end ? end : undefined,
    });
    onToggle();
  };

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          Tweak beat metadata
        </h4>
        <button
          type="button"
          onClick={onToggle}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Close
        </button>
      </div>
      <div className="space-y-2">
        <Field label="Label">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </Field>
        <Field label="Narration excerpt">
          <textarea
            value={narration}
            onChange={(e) => setNarration(e.target.value)}
            rows={2}
            className="w-full resize-none rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Start (s)">
            <input
              type="number"
              step={0.01}
              value={start}
              onChange={(e) => setStart(parseFloat(e.target.value) || 0)}
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </Field>
          <Field label="End (s)">
            <input
              type="number"
              step={0.01}
              value={end}
              onChange={(e) => setEnd(parseFloat(e.target.value) || 0)}
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </Field>
        </div>
        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={save}
            disabled={!dirty}
            className={cn(
              "rounded-md border border-input bg-background px-3 py-1 text-xs font-medium",
              "hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40",
            )}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-0.5 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
