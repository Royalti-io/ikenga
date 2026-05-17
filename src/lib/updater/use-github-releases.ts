// Fetch the recent Ikenga releases from GitHub for the About page's changelog
// feed and for "what's in this update" release notes. Unauthenticated; the
// GH REST API allows 60 requests/hr per IP which is plenty for the
// once-per-hour cadence here.
//
// We don't fall back to the updater plugin's `body` for notes because it
// only gives us the *latest* release. The feed surfaces history too.

import { useQuery } from '@tanstack/react-query';

export interface GitHubRelease {
	tagName: string;
	name: string;
	publishedAt: string;
	body: string;
	htmlUrl: string;
	prerelease: boolean;
}

const RELEASES_URL = 'https://api.github.com/repos/Royalti-io/ikenga/releases?per_page=20';

async function fetchReleases(signal?: AbortSignal): Promise<GitHubRelease[]> {
	const res = await fetch(RELEASES_URL, {
		signal,
		headers: { Accept: 'application/vnd.github+json' },
	});
	if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`);
	const raw = (await res.json()) as Array<{
		tag_name: string;
		name: string | null;
		published_at: string;
		body: string | null;
		html_url: string;
		prerelease: boolean;
		draft: boolean;
	}>;
	return raw
		.filter((r) => !r.draft)
		.map((r) => ({
			tagName: r.tag_name,
			name: r.name ?? r.tag_name,
			publishedAt: r.published_at,
			body: r.body ?? '',
			htmlUrl: r.html_url,
			prerelease: r.prerelease,
		}));
}

const ONE_HOUR_MS = 60 * 60 * 1000;

export function useGitHubReleases() {
	return useQuery({
		queryKey: ['updater', 'github-releases'],
		queryFn: ({ signal }) => fetchReleases(signal),
		staleTime: ONE_HOUR_MS,
		refetchInterval: ONE_HOUR_MS,
		refetchOnWindowFocus: false,
		retry: 1,
	});
}

/** Find the release matching a given version. Matches `tagName === version`
 *  or `tagName === 'v' + version` (both conventions appear in the wild). */
export function findReleaseByVersion(
	releases: GitHubRelease[] | undefined,
	version: string
): GitHubRelease | undefined {
	if (!releases) return undefined;
	return releases.find((r) => r.tagName === version || r.tagName === `v${version}`);
}
