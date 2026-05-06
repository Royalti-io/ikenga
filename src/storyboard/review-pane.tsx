/**
 * Center pane: rung tabs, current rung's still preview + content, comments,
 * and the action bar (approve / send back / send note / tweak).
 *
 * Ported from storyboard-app/src/components/ReviewPane.tsx; CompareView
 * descoped (defer to phase 7.1).
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Loader2, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";
import type { BeatStatus, Rung, StoryboardBeat } from "@/lib/storyboard/types";

import { CommentThread, type CommentThreadRef } from "./comment-thread";
import { StillImage } from "./still-image";
import { TweakDrawer } from "./tweak-drawer";

type ActiveRung = 0 | 1 | 2;

interface ReviewPaneProps {
  beat: StoryboardBeat;
  beatIndex: number;
  totalBeats: number;
  storyboardSlug: string;
  activeRung: ActiveRung;
  onSetActiveRung: (rung: ActiveRung) => void;
  onApprove: (beatId: string, rung: Rung) => void;
  onNeedsRework: (beatId: string, rung: Rung) => void;
  onAddComment: (beatId: string, text: string, rung: number) => void;
  onSendNote: (beatId: string, text: string, rung: number) => void;
  onTweakBeat: (
    beatId: string,
    patch: {
      label?: string;
      narration_excerpt?: string;
      timeStart?: number;
      timeEnd?: number;
    },
  ) => void;
  onRenderStill: (beatId: string, rung: 1 | 2) => void;
  isRendering: boolean;
}

export interface ReviewPaneRef {
  focusComment: () => void;
  toggleTweak: () => void;
  startSendNote: () => void;
}

const STATUS_LABEL: Record<BeatStatus, string> = {
  pending: "Pending",
  "pending-review": "Pending review",
  approved: "Approved",
  "needs-rework": "Needs rework",
};

const STATUS_PILL: Record<BeatStatus, string> = {
  pending: "border-border bg-muted text-muted-foreground",
  "pending-review":
    "border-amber-300 bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300",
  approved:
    "border-emerald-300 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300",
  "needs-rework":
    "border-red-300 bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300",
};

const STATUS_DOT: Record<BeatStatus, string> = {
  pending: "bg-muted-foreground",
  "pending-review": "bg-amber-500",
  approved: "bg-emerald-500",
  "needs-rework": "bg-red-500",
};

const RUNG_KEY_MAP: Record<ActiveRung, Rung> = {
  0: "0_beat_sheet",
  1: "1_lofi",
  2: "2_hifi",
};
const RUNG_LABEL = ["Beat Sheet", "Lo-fi", "Hi-fi"] as const;

export const ReviewPane = forwardRef<ReviewPaneRef, ReviewPaneProps>(
  function ReviewPane(
    {
      beat,
      beatIndex,
      totalBeats,
      storyboardSlug,
      activeRung,
      onSetActiveRung,
      onApprove,
      onNeedsRework,
      onAddComment,
      onSendNote,
      onTweakBeat,
      onRenderStill,
      isRendering,
    },
    ref,
  ) {
    const [tweakOpen, setTweakOpen] = useState(false);
    const [noteMode, setNoteMode] = useState(false);
    const [noteText, setNoteText] = useState("");
    const commentRef = useRef<CommentThreadRef>(null);
    const noteRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
      setNoteMode(false);
      setNoteText("");
    }, [beat.id]);

    useImperativeHandle(
      ref,
      () => ({
        focusComment: () => commentRef.current?.focus(),
        toggleTweak: () => setTweakOpen((v) => !v),
        startSendNote: () => {
          setNoteMode(true);
          setTimeout(() => noteRef.current?.focus(), 0);
        },
      }),
      [],
    );

    const currentRungKey = RUNG_KEY_MAP[activeRung];
    const currentStatus = beat.rungs[currentRungKey].status;

    const handleApprove = () => onApprove(beat.id, currentRungKey);
    const handleRework = () => onNeedsRework(beat.id, currentRungKey);

    const submitNote = () => {
      const text = noteText.trim();
      if (!text) return;
      onSendNote(beat.id, text, activeRung);
      setNoteText("");
      setNoteMode(false);
    };

    const cancelNote = () => {
      setNoteMode(false);
      setNoteText("");
    };

    return (
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        {/* Beat header */}
        <div className="border-b border-border bg-card px-5 py-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                <span>
                  BEAT {String(beatIndex + 1).padStart(2, "0")} /{" "}
                  {String(totalBeats).padStart(2, "0")}
                </span>
                <span>·</span>
                <span>
                  {beat.frames.start}–{beat.frames.end}f
                </span>
              </div>
              <h2 className="mt-0.5 flex items-center gap-2 text-base font-bold">
                <span
                  className={cn(
                    "inline-block h-2.5 w-2.5 rounded-full",
                    STATUS_DOT[currentStatus],
                  )}
                />
                {beat.label}
              </h2>
              <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                {beat.time.start.toFixed(2)}s → {beat.time.end.toFixed(2)}s
              </div>
            </div>
            <span
              className={cn(
                "whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium",
                STATUS_PILL[currentStatus],
              )}
            >
              Rung {activeRung} · {STATUS_LABEL[currentStatus]}
            </span>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto">
          <div className="space-y-4 p-5">
            {/* Rung tabs */}
            <div className="flex gap-2">
              {([0, 1, 2] as const).map((r) => {
                const st = beat.rungs[RUNG_KEY_MAP[r]].status;
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => onSetActiveRung(r)}
                    className={cn(
                      "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                      activeRung === r
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "mr-1.5 inline-block h-1.5 w-1.5 rounded-full",
                        STATUS_DOT[st],
                      )}
                    />
                    Rung {r} · {RUNG_LABEL[r]}
                  </button>
                );
              })}
            </div>

            {/* Rung-specific content */}
            <RungBody
              beat={beat}
              rung={activeRung}
              storyboardSlug={storyboardSlug}
              onRenderStill={(rung) => onRenderStill(beat.id, rung)}
              isRendering={isRendering}
            />

            {/* Tweak drawer */}
            <TweakDrawer
              open={tweakOpen}
              beat={beat}
              onSave={(patch) => onTweakBeat(beat.id, patch)}
              onToggle={() => setTweakOpen((v) => !v)}
            />

            {/* Comments */}
            <div className="rounded-lg border border-border bg-card p-3">
              <h4 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Comments {beat.comments.length > 0 && `(${beat.comments.length})`}
              </h4>
              <CommentThread
                ref={commentRef}
                comments={beat.comments}
                activeRung={activeRung}
                onAddComment={(text, rung) => onAddComment(beat.id, text, rung)}
              />
            </div>
          </div>
        </div>

        {/* Action bar */}
        <div className="border-t border-border bg-card px-5 py-3">
          {noteMode ? (
            <div className="space-y-2">
              <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Send note · marks Rung {activeRung} as needs-rework + attaches
                your comment
              </div>
              <textarea
                ref={noteRef}
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    submitNote();
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    cancelNote();
                  }
                }}
                rows={2}
                placeholder={`What needs to change at Rung ${activeRung} (${RUNG_LABEL[activeRung]})? Cmd+Enter to submit · Esc to cancel`}
                className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={cancelNote}>
                  Cancel
                </Button>
                <Button size="sm" onClick={submitNote} disabled={!noteText.trim()}>
                  Send note
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={handleApprove}
                  disabled={currentStatus === "approved"}
                  title="Approve (A)"
                >
                  {currentStatus === "approved" ? "✓ " : "○ "}
                  Approve Rung {activeRung}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleRework}
                  disabled={currentStatus === "needs-rework"}
                  title="Send back (R)"
                  className="border-red-300 text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-900/20"
                >
                  Send back
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => commentRef.current?.focus()}
                  title="Comment (C)"
                >
                  Comment
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setNoteMode(true);
                    setTimeout(() => noteRef.current?.focus(), 0);
                  }}
                  title="Send note (N)"
                >
                  ↪ Send note
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setTweakOpen((v) => !v)}
                  title="Tweak (E)"
                >
                  {tweakOpen ? "Close tweak" : "Tweak"}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  },
);

function RungBody({
  beat,
  rung,
  onRenderStill,
  isRendering,
}: {
  beat: StoryboardBeat;
  rung: ActiveRung;
  storyboardSlug: string;
  onRenderStill: (rung: 1 | 2) => void;
  isRendering: boolean;
}) {
  if (rung === 0) {
    const content = beat.rungs["0_beat_sheet"].content;
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <h4 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          Beat sheet
        </h4>
        {content ? (
          <p className="whitespace-pre-wrap text-sm">{content}</p>
        ) : (
          <p className="text-sm italic text-muted-foreground">
            No content. Edit via the agent flow (phase 7.1) or paste a beat sheet.
          </p>
        )}
        {beat.narration_excerpt && (
          <>
            <h4 className="mb-1 mt-4 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Narration
            </h4>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {beat.narration_excerpt}
            </p>
          </>
        )}
      </div>
    );
  }
  const stillPath =
    rung === 1
      ? beat.rungs["1_lofi"].still_path
      : beat.rungs["2_hifi"].still_path;
  const tsxAnchor = rung === 1 ? beat.rungs["1_lofi"].tsx_anchor : null;
  return (
    <div className="space-y-3">
      <StillImage
        path={stillPath}
        cacheKey={stillPath ?? "empty"}
        className="aspect-[9/16] w-full max-w-[320px] rounded-md border border-border object-contain"
        alt={`${beat.label} · Rung ${rung}`}
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => onRenderStill(rung as 1 | 2)}
          disabled={isRendering}
        >
          {isRendering ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <Play className="mr-1 h-4 w-4" />
          )}
          {stillPath ? "Re-render still" : "Render still"}
        </Button>
        {tsxAnchor && (
          <span
            className="font-mono text-[11px] text-muted-foreground"
            title={tsxAnchor}
          >
            TSX: <code>{tsxAnchor}</code>
          </span>
        )}
      </div>
    </div>
  );
}
