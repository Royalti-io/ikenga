/**
 * Comment thread for a beat. Append-only list + textarea.
 * Ported from storyboard-app/src/components/CommentThread.tsx.
 */

import { forwardRef, useImperativeHandle, useRef, useState } from "react";

import { cn } from "@/components/ui/utils";
import type { BeatComment } from "@/lib/storyboard/types";

interface CommentThreadProps {
  comments: BeatComment[];
  activeRung: number;
  onAddComment: (text: string, rung: number) => void;
}

export interface CommentThreadRef {
  focus: () => void;
}

export const CommentThread = forwardRef<CommentThreadRef, CommentThreadProps>(
  function CommentThread({ comments, activeRung, onAddComment }, ref) {
    const [text, setText] = useState("");
    const taRef = useRef<HTMLTextAreaElement>(null);

    useImperativeHandle(ref, () => ({
      focus: () => taRef.current?.focus(),
    }));

    const submit = () => {
      const trimmed = text.trim();
      if (!trimmed) return;
      onAddComment(trimmed, activeRung);
      setText("");
    };

    return (
      <div className="space-y-2">
        {comments.length > 0 ? (
          <ul className="space-y-1.5">
            {comments.map((c, i) => (
              <li
                key={i}
                className="rounded border border-border bg-muted/40 px-2.5 py-1.5 text-xs"
              >
                <div className="mb-0.5 font-mono text-[10px] text-muted-foreground">
                  Rung {c.rung} · {new Date(c.ts).toLocaleString()}
                </div>
                <div className="whitespace-pre-wrap">{c.text}</div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-xs italic text-muted-foreground">No comments yet.</div>
        )}

        <div className="flex gap-2">
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
            placeholder={`Comment on Rung ${activeRung} · Cmd+Enter to send`}
            className={cn(
              "flex-1 resize-none rounded-md border border-input bg-background px-2 py-1.5 text-xs",
              "placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring",
            )}
          />
          <button
            type="button"
            onClick={submit}
            disabled={!text.trim()}
            className={cn(
              "self-end rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium",
              "hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40",
            )}
          >
            Send
          </button>
        </div>
      </div>
    );
  },
);
