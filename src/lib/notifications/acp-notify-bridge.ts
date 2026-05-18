// Phase 9 (ACP migration): OS notification + sidebar-badge dispatcher for
// the `acp://notify` Tauri event.
//
// The Rust ACP server (`src-tauri/src/acp/server.rs`) emits an
// `acp://notify` whenever claude wants the user's attention — either via
// the `Notification` system_hook or via a `PermissionRequest`
// round-trip. Two things should happen on each event:
//
//   1. Bump the sidebar badge counter for that thread (so the user sees
//      the dot in the sessions list).
//   2. Fire an OS notification IF the user can't already see what's
//      happening — i.e. the window is unfocused OR the user is on a
//      different thread.
//
// Focus suppression rules (the matrix the function below implements):
//
//                        | window focused | window unfocused
//   ----------------------+----------------+------------------
//   on this thread        | suppress both  | OS + badge
//   on a different thread | OS + badge     | OS + badge
//
// In other words: when window is focused AND active pane is on the thread
// in question, the in-UI `PermissionDialog` (Phase 4) or in-line
// "Notification" surface is already visible — no OS distraction needed.
// In every other case, both an OS notification AND the sidebar badge
// fire so the user can find their way back to the right thread.
//
// `startAcpNotifyBridge` is idempotent — calling it twice from the same
// process returns the same unsubscribe and only registers one listener.
// Subsequent calls during the React StrictMode double-invoke or HMR
// reload won't create duplicate notifications.

import {
	isPermissionGranted,
	requestPermission,
	sendNotification,
} from '@tauri-apps/plugin-notification';

import { chatListenNotify, type AcpNotifyPayload } from '@/lib/tauri-cmd';
import { usePaneStore } from '@/lib/panes/pane-store';
import { useThreadBadges } from '@/lib/shell/thread-badges-store';

type Unsubscribe = () => void;

let activeBridge: { unsubscribe: Unsubscribe; refCount: number } | null = null;

/**
 * Start the global ACP notify bridge. Returns an unsubscribe that decrements
 * an internal refcount; the underlying Tauri listener is only torn down
 * when the last caller unsubscribes.
 *
 * Call this once from the app root layout. The returned cleanup is a no-op
 * in practice (the bridge lives for the lifetime of the app), but it
 * exists so React's StrictMode double-mount + HMR teardown stay clean.
 */
export function startAcpNotifyBridge(): Unsubscribe {
	if (activeBridge) {
		activeBridge.refCount += 1;
		return makeRefCountedUnsubscribe();
	}

	let unlisten: Unsubscribe | null = null;
	let disposed = false;

	// Kick off the OS-side permission request once at bridge start. On
	// Linux + Windows this is a near-instant no-op (the OS grants by
	// default). On macOS the first call shows a system dialog the user
	// must accept; without it, sendNotification silently no-ops.
	void ensureNotificationPermission();

	void chatListenNotify(handleNotify).then((un) => {
		if (disposed) {
			// Caller already unsubscribed before listen() resolved — tear
			// down immediately so we don't leak a Tauri listener.
			un();
			return;
		}
		unlisten = un;
	});

	activeBridge = {
		refCount: 1,
		unsubscribe: () => {
			disposed = true;
			if (unlisten) {
				unlisten();
				unlisten = null;
			}
			activeBridge = null;
		},
	};

	return makeRefCountedUnsubscribe();
}

function makeRefCountedUnsubscribe(): Unsubscribe {
	let called = false;
	return () => {
		if (called) return;
		called = true;
		if (!activeBridge) return;
		activeBridge.refCount -= 1;
		if (activeBridge.refCount <= 0) {
			activeBridge.unsubscribe();
		}
	};
}

/**
 * Decide what to do with an incoming notify and act on it.
 *
 * Exposed for testing — the unit tests pass synthetic payloads through
 * here and assert on what state changed. The real bridge wires this
 * function to `chatListenNotify`.
 */
export function handleNotify(payload: AcpNotifyPayload): void {
	const decision = decideDispatch(payload, {
		windowFocused: documentHasFocus(),
		focusedThreadId: focusedThreadIdFromPaneStore(),
	});

	if (decision.bumpBadge) {
		useThreadBadges.getState().bump(payload.threadId);
	}
	if (decision.fireOsNotification) {
		void fireOsNotification(payload);
	}
}

export interface DispatchInputs {
	windowFocused: boolean;
	focusedThreadId: string | null;
}

export interface DispatchDecision {
	bumpBadge: boolean;
	fireOsNotification: boolean;
}

/** Pure-function policy. The single place that owns the matrix above. */
export function decideDispatch(
	payload: AcpNotifyPayload,
	inputs: DispatchInputs
): DispatchDecision {
	const onThisThread =
		inputs.focusedThreadId !== null && inputs.focusedThreadId === payload.threadId;

	// Window focused AND on this thread → fully suppress. The in-UI
	// surface (PermissionDialog / inline notification) is already visible
	// and any extra OS popup / badge would be noise.
	if (inputs.windowFocused && onThisThread) {
		return { bumpBadge: false, fireOsNotification: false };
	}

	// Every other case → OS notification + badge. Even when the window is
	// focused but the user is on a different thread, an OS notification
	// is appropriate (the user might be deep in another conversation and
	// would otherwise miss the prompt).
	return { bumpBadge: true, fireOsNotification: true };
}

/** Wraps the document.hasFocus() check so tests can swap it. */
function documentHasFocus(): boolean {
	if (typeof document === 'undefined') return false;
	try {
		return document.hasFocus();
	} catch {
		// In some webview environments hasFocus() throws on first paint —
		// treat as unfocused so the user definitely gets a notification.
		return false;
	}
}

/**
 * Resolve "what thread is the user currently looking at?" from the pane
 * store. Returns the sessionId of the focused chat-kind view, or null if
 * the focused view isn't a chat (terminal, viewer, route, etc.).
 *
 * Reads via `getState()` rather than subscribing because this function is
 * called inside an event listener, not a React render.
 */
function focusedThreadIdFromPaneStore(): string | null {
	try {
		const view = usePaneStore.getState().focusedView();
		if (view && view.kind === 'chat') {
			return view.sessionId;
		}
		// TODO(phase-10): also resolve via TanStack Router location for
		// the `/sessions/$sessionId` route when no pane is in chat view.
		// Today the sessions route renders into the content pane and the
		// pane-store does not track its address, so a user on
		// `/sessions/<id>` (without an explicit chat pane) is treated as
		// "not on this thread" and gets OS notifications. The UX cost
		// is minor (extra notification) and acceptable for Phase 9.
		return null;
	} catch {
		return null;
	}
}

/**
 * Fire the OS notification through `tauri-plugin-notification`. Silent on
 * failure — the badge bump is the primary surface and a missed OS popup
 * shouldn't break the bridge.
 */
async function fireOsNotification(payload: AcpNotifyPayload): Promise<void> {
	try {
		const granted = await isPermissionGranted();
		if (!granted) {
			const result = await requestPermission();
			if (result !== 'granted') {
				return;
			}
		}
		sendNotification({
			title: payload.title,
			body: payload.body,
		});
	} catch (e) {
		console.warn('[acp-notify] sendNotification failed', e);
	}
}

async function ensureNotificationPermission(): Promise<void> {
	try {
		const granted = await isPermissionGranted();
		if (!granted) {
			await requestPermission();
		}
	} catch (e) {
		console.warn('[acp-notify] permission probe failed', e);
	}
}
