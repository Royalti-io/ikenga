// Dev-only globals. Imported eagerly by `main.tsx` in dev builds so iyke
// (and developer console scripting) can reach helpers without going
// through a UI. Production builds tree-shake the import via the
// `import.meta.env.DEV` guard in main.tsx.

import { runAcpSmokeTest } from './acp-smoke';

declare global {
	interface Window {
		ikengaAcpSmoke?: typeof runAcpSmokeTest;
	}
}

if (typeof window !== 'undefined') {
	window.ikengaAcpSmoke = runAcpSmokeTest;
}

export {};
