# ikenga-artifact-builder

A Claude Code skill that teaches the agent to author **single-file HTML
artifacts** — dashboards, views, comparisons, mockups — that render
standalone in any browser and light up with live data when opened inside
the Ikenga shell.

See [`SKILL.md`](./SKILL.md) for the full spec the agent reads at trigger
time (frontmatter, hard rules, single-file template, data-source types,
refresh modes, compatibility constraints, bridge cheat sheet).

See [`references/`](./references) for three working examples in increasing
complexity:

- `hello-world.html` — minimal, one fetch source. Read first.
- `cfo-daily.html` — financial dashboard, four source types, three refresh modes.
- `ceo-overview.html` — exec digest, six sources, cross-artifact links.

To view any reference, just open the `.html` file in a browser — no build
step, no install. Each artifact ships with mock data and renders fully
offline; live data only kicks in when the file is opened inside the
Ikenga shell.
