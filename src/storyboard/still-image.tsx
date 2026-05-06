/**
 * Loads a still PNG from the engine's compositions directory via fs_read
 * (allowlisted to ~/royalti-co/**) and renders it as a blob URL. Pure FE —
 * no Tauri command, just the existing fs_read.
 */

import { useEffect, useRef, useState } from "react";

import { fsRead } from "@/lib/tauri-cmd";
import { cn } from "@/components/ui/utils";

interface StillImageProps {
  /** Absolute path or path relative to engine root. */
  path: string | null | undefined;
  /** Cache-bust key — bump to force re-fetch (e.g. after a render). */
  cacheKey?: string | number;
  className?: string;
  alt?: string;
}

const ENGINE_ROOT = "~/royalti-co/royalti-video-engine";

function resolvePath(p: string): string {
  if (p.startsWith("/") || p.startsWith("~")) return p;
  return `${ENGINE_ROOT}/${p}`;
}

export function StillImage({ path, cacheKey, className, alt }: StillImageProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!path) {
      setSrc(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setError(null);
    fsRead(resolvePath(path))
      .then((res) => {
        if (cancelled) return;
        const blob = new Blob([new Uint8Array(res.bytes)], {
          type: res.mime || "image/png",
        });
        const url = URL.createObjectURL(blob);
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = url;
        setSrc(url);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setSrc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [path, cacheKey]);

  // Revoke the last blob URL on unmount.
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    };
  }, []);

  if (!path) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-md border border-dashed border-border bg-muted/40 text-xs text-muted-foreground",
          className,
        )}
      >
        No still rendered yet
      </div>
    );
  }
  if (error) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-md border border-red-300 bg-red-50 px-2 py-4 text-center text-xs text-red-700 dark:bg-red-900/20 dark:text-red-300",
          className,
        )}
      >
        <span className="break-all font-mono">{error}</span>
      </div>
    );
  }
  if (!src) {
    return (
      <div
        className={cn(
          "flex animate-pulse items-center justify-center rounded-md border border-border bg-muted/40 text-xs text-muted-foreground",
          className,
        )}
      >
        Loading still…
      </div>
    );
  }
  return <img src={src} alt={alt ?? "Storyboard still"} className={className} />;
}
