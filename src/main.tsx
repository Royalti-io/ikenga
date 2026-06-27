import { mark } from '@/lib/boot-timing';
mark('boot:js-start');

import './styles.css';
import { isDetachedWindow } from '@/lib/window/window-context';

// Single SPA entry, two boot paths (plans/multi-window WP-05, G-02 — same
// entry + a lazy code-split, NOT a second Vite entry, which would hit Tauri
// #4372). `WindowRegistry::spawn` (Rust) appends `?window=<label>&surfaces=…`
// to the same app URL as `main`, so a detached window is detected here and
// boots the thin surface-host instead of the full workspace. Each path is a
// dynamic import so the detached window never parses the primary bundle (the
// router tree, every route, the workspace chrome).
if (isDetachedWindow()) {
	void import('@/boot/detached').then((m) => m.bootDetached());
} else {
	void import('@/boot/primary').then((m) => m.bootPrimary());
}
