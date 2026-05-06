import { useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { viewerServe, viewerStop, type ViewerHandle } from "@/lib/tauri-cmd";
import { basename, dirname } from "../lib/path";

interface AudioViewProps {
  path: string;
}

// Native <audio> + a peaks.js waveform overlay. Peaks needs a PeaksContainer,
// an HTMLAudioElement, and a precomputed waveform OR a webAudioContext to
// generate one on the fly. We use the AudioContext path so we don't need
// server-side waveform generation. If peaks fails to init (e.g. WebAudio
// rejects the codec), we leave the audio controls and skip the waveform.
export function AudioView({ path }: AudioViewProps) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; src: string; handle: ViewerHandle }
    | { kind: "error"; message: string }
  >({ kind: "loading" });
  const audioRef = useRef<HTMLAudioElement>(null);
  const overviewRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<HTMLDivElement>(null);
  const peaksRef = useRef<{ destroy: () => void } | null>(null);
  const [waveformReady, setWaveformReady] = useState(false);
  const [waveformError, setWaveformError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let handle: ViewerHandle | null = null;
    setState({ kind: "loading" });
    setWaveformReady(false);
    setWaveformError(null);

    viewerServe(dirname(path))
      .then((h) => {
        handle = h;
        if (cancelled) {
          void viewerStop(h.token);
          return;
        }
        setState({
          kind: "ready",
          src: `${h.url}${basename(path)}`,
          handle: h,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });

    return () => {
      cancelled = true;
      if (peaksRef.current) {
        peaksRef.current.destroy();
        peaksRef.current = null;
      }
      if (handle) void viewerStop(handle.token);
    };
  }, [path]);

  // Initialize peaks.js once the audio src is set + the audio element has
  // loaded enough metadata to be playable. Lazy-import keeps the ~200KB
  // peaks bundle out of the initial JS chunk.
  useEffect(() => {
    if (state.kind !== "ready") return;
    if (!audioRef.current || !overviewRef.current || !zoomRef.current) return;
    let cancelled = false;

    (async () => {
      try {
        const Peaks = (await import("peaks.js")).default;
        if (cancelled) return;
        const audioCtx = new (window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext)();
        Peaks.init(
          {
            overview: { container: overviewRef.current! },
            zoomview: { container: zoomRef.current! },
            mediaElement: audioRef.current!,
            webAudio: { audioContext: audioCtx },
          },
          (err, instance) => {
            if (cancelled) {
              instance?.destroy();
              return;
            }
            if (err) {
              setWaveformError(err.message);
              return;
            }
            if (instance) {
              peaksRef.current = instance;
              setWaveformReady(true);
            }
          },
        );
      } catch (err) {
        if (!cancelled) {
          setWaveformError(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [state]);

  if (state.kind === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="flex h-full items-start justify-center p-6 text-xs text-destructive">
        <AlertCircle className="mr-2 mt-0.5 h-4 w-4 shrink-0" />
        <span className="break-all">{state.message}</span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex-1 overflow-hidden">
        <div
          ref={zoomRef}
          className="h-2/3 w-full bg-muted/40"
          style={{ display: waveformReady ? "block" : "none" }}
        />
        <div
          ref={overviewRef}
          className="h-1/3 w-full border-t border-border bg-muted/20"
          style={{ display: waveformReady ? "block" : "none" }}
        />
        {!waveformReady && !waveformError && (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Generating
            waveform…
          </div>
        )}
        {waveformError && (
          <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
            Waveform unavailable ({waveformError}). Audio controls below still
            work.
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-border bg-muted/30 p-3">
        <audio
          ref={audioRef}
          src={state.src}
          controls
          className="w-full"
          // eslint-disable-next-line jsx-a11y/media-has-caption
        />
      </div>
    </div>
  );
}
