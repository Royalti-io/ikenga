// Dev-only globals. Imported eagerly by `main.tsx` in dev builds so iyke
// (and developer console scripting) can reach helpers without going
// through a UI. Production builds tree-shake the import via the
// `import.meta.env.DEV` guard in main.tsx.

import {
	runAcpForkSmokeTest,
	runAcpImageSmokeTest,
	runAcpInterruptSmokeTest,
	runAcpSmokeTest,
	watchAcpNotify,
} from './acp-smoke';
// Side-effect import: installs window.__bgSpikeReply + window.bgSpikeRun.
import './bg-spike';

declare global {
	interface Window {
		ikengaAcpSmoke?: typeof runAcpSmokeTest;
		ikengaAcpInterruptSmoke?: typeof runAcpInterruptSmokeTest;
		ikengaAcpImageSmoke?: typeof runAcpImageSmokeTest;
		ikengaAcpForkSmoke?: typeof runAcpForkSmokeTest;
		ikengaAcpNotifyWatch?: typeof watchAcpNotify;
	}
}

if (typeof window !== 'undefined') {
	window.ikengaAcpSmoke = runAcpSmokeTest;
	window.ikengaAcpInterruptSmoke = runAcpInterruptSmokeTest;
	window.ikengaAcpImageSmoke = runAcpImageSmokeTest;
	window.ikengaAcpForkSmoke = runAcpForkSmokeTest;
	window.ikengaAcpNotifyWatch = watchAcpNotify;
}

export {};
