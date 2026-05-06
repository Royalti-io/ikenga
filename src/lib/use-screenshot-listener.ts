// Workspace-level hook that bridges screenshot events with the DOM.
//
// Two events to handle:
//  1. `screenshot://request` — Rust capture helper asking us to render a
//     target to PNG. We capture, base64-encode, post back via
//     `screenshot_capture_done`. The Rust side awaits a oneshot keyed on
//     `request_id` and writes the bytes to disk.
//  2. `screenshot://shortcut` — global shortcut fired in Rust. We resolve
//     "focused pane" here (instead of mirroring usePaneStore on the Rust
//     side just for this) and invoke the matching Tauri command.

import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { capturePane, captureWindow } from '@/lib/screenshot';
import { useIykeActivity } from '@/lib/iyke/activity-store';
import { usePaneStore } from '@/lib/panes/pane-store';
import { screenshotPane, screenshotWindow } from '@/lib/tauri-cmd';

interface RequestPayload {
  request_id: string;
  kind: 'window' | 'pane';
  pane_id: string | null;
}

interface ShortcutPayload {
  kind: 'window' | 'pane-focused';
}

export function useScreenshotListener() {
  useEffect(() => {
    let alive = true;
    const unlisteners: Array<() => void> = [];

    void (async () => {
      const offReq = await listen<RequestPayload>('screenshot://request', async (e) => {
        const { request_id, kind, pane_id } = e.payload;
        const scope = kind === 'pane' && pane_id ? pane_id : 'window';
        const actId = useIykeActivity.getState().begin({ kind: 'screenshot', scope });
        try {
          const out =
            kind === 'window'
              ? await captureWindow()
              : await capturePane(pane_id ?? '');
          await invoke('screenshot_capture_done', {
            args: {
              request_id,
              png_base64: out.base64,
              width: out.width,
              height: out.height,
            },
          });
        } catch (err) {
          // Report failure so the Rust oneshot resolves immediately
          // instead of waiting out the 60s capture timeout.
          // eslint-disable-next-line no-console
          console.warn('[screenshot] capture failed', err);
          try {
            await invoke('screenshot_capture_failed', {
              args: {
                request_id,
                message: err instanceof Error ? err.message : String(err),
              },
            });
          } catch (reportErr) {
            // eslint-disable-next-line no-console
            console.warn('[screenshot] failed to report failure', reportErr);
          }
        } finally {
          useIykeActivity.getState().end(actId);
        }
      });
      if (!alive) {
        offReq();
        return;
      }
      unlisteners.push(offReq);

      const offShortcut = await listen<ShortcutPayload>(
        'screenshot://shortcut',
        async (e) => {
          try {
            if (e.payload.kind === 'window') {
              await screenshotWindow();
            } else {
              const focusedId = usePaneStore.getState().focusedId;
              if (focusedId) {
                await screenshotPane(focusedId);
              } else {
                // No focused pane — fall back to a window capture so the
                // shortcut isn't a silent no-op.
                await screenshotWindow();
              }
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[screenshot] shortcut handler failed', err);
          }
        },
      );
      if (!alive) {
        offShortcut();
        return;
      }
      unlisteners.push(offShortcut);
    })();

    return () => {
      alive = false;
      for (const off of unlisteners) off();
    };
  }, []);
}
