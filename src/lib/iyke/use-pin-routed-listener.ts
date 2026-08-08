// Shell-level listener for `pin://routed` events.
//
// The legacy chat surface used this to dispatch a pin summary into the
// focused chat thread. With the chat pane removed, the event is still
// emitted by the Rust side but no longer has a chat pane to target.
// The replacement is the `iyke chi` CLI / MCP surface; this FE hook is
// intentionally a no-op so workspace.tsx and grid.tsx keep compiling
// without introducing new UI.

/** Mount-once hook for the workspace shell. No-ops now that chat panes are gone. */
export function usePinRoutedListener(): void {
	// Intentionally empty — pin routing lives in the chi CLI/MCP layer.
}
