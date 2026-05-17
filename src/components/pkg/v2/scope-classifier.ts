// Classify a permission scope string into a risk band + human label.
// Mirrors design/shell/concepts/04-pkgs/04-package-manager/_render.js::classifyScope.

export type ScopeRisk = 'low' | 'med' | 'high';

export interface ScopeClass {
	risk: ScopeRisk;
	label: string;
}

const RULES: Array<[RegExp, ScopeRisk, string]> = [
	[/^fs:write/, 'high', 'Write to disk'],
	[/^shell\.execute/, 'high', 'Run binary'],
	[/^supabase:write/, 'high', 'Write to Supabase'],
	[/^shell:engine/, 'high', 'Acts as the engine adapter'],
	[/^net:https/, 'med', 'Network · outbound HTTPS'],
	[/^vault:read/, 'med', 'Read secret from vault'],
	[/^shell:dom/, 'med', 'Read shell DOM (a11y tree)'],
	[/^shell:nav/, 'med', 'Drive shell navigation'],
	[/^net:127\.0\.0\.1/, 'low', 'Loopback only'],
	[/^supabase:read/, 'low', 'Read from Supabase'],
	[/^fs:read/, 'low', 'Read from disk'],
	[/^sidecar:/, 'low', 'Bundled sidecar binary'],
];

export function classifyScope(scope: string): ScopeClass {
	for (const [pattern, risk, label] of RULES) {
		if (pattern.test(scope)) return { risk, label };
	}
	return { risk: 'low', label: 'Unclassified' };
}

export function riskColor(risk: ScopeRisk): string {
	if (risk === 'high') return 'text-red-500';
	if (risk === 'med') return 'text-amber-500';
	return 'text-emerald-500';
}
