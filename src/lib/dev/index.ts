// Dev-only globals. Imported eagerly by `main.tsx` in dev builds so iyke
// (and developer console scripting) can reach helpers without going
// through a UI. Production builds tree-shake the import via the
// `import.meta.env.DEV` guard in main.tsx.

// Side-effect import: installs window.__bgSpikeReply + window.bgSpikeRun.
import './bg-spike';

export {};
