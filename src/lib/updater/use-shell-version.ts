// Read the running shell's version from Tauri's app handle. Returns null
// during initial fetch and on read failure (graceful for storybook /
// non-Tauri webviews; the About page falls back to "—").

import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';

export function useShellVersion(): string | null {
	const [version, setVersion] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		void getVersion()
			.then((v) => {
				if (!cancelled) setVersion(v);
			})
			.catch(() => {
				if (!cancelled) setVersion(null);
			});
		return () => {
			cancelled = true;
		};
	}, []);
	return version;
}
