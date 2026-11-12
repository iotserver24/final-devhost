# Sentinel Dashboard Design

The dashboard is an Operate surface: a local incident control room for developers. Its visual world is a dark, instrument-like workspace with restrained color reserved for state.

## Visual system

- Backgrounds: near-black neutral surfaces with a clear raised-surface hierarchy, in the restrained spirit of the Vercel dashboard.
- Accent: white is the primary action and selection language; cool blue is reserved for links and focus; green means healthy, amber means degraded or awaiting attention, and red means stopped or unsafe.
- Typography: Space Grotesk for headings and IBM Plex Sans for operational copy; monospace is reserved for revisions, routes, codes, and hosts.
- Layout: a stable incident rail beside an evidence detail pane; settings use a guided primary-provider section followed by optional configuration.
- Depth: separation comes from borders, surface changes, and spacing rather than decorative shadows or gradients.

## Interaction rules

- Keep connection and save states explicit.
- Never echo secret values after saving.
- Preserve visible keyboard focus and reduced-motion behavior.
- Keep incident state scannable before the operator reads the full timeline.
