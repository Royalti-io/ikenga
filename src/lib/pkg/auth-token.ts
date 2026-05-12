// Per-iframe auth token (D5 stub).
//
// Minted on iframe boot, included in `hostContext.royaltiAuth.token`, and
// also used as the URL token for the pkg_content server. v1: no sidecar
// validates the token. The full enforcement contract lands with the first
// sidecar-owning pkg (Hyperframes) — at that point sidecars receive the
// token in every request and reject anything that doesn't match the
// host-issued value for the live mount.
//
// Generates 32 bytes of crypto-random hex via `crypto.getRandomValues`.
// Tauri ships a Web Crypto-capable runtime in both the dev and prod webview.

export function mintPkgToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
