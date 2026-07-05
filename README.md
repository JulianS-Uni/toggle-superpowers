# toggle-superpowers

A [pi](https://github.com/earendil-works/pi-mono) extension that puts
[obra/superpowers](https://github.com/obra/superpowers) behind an explicit
opt-in: nothing is visible to the model until you run `/superpowers`.

It is a fork of upstream's
[`.pi/extensions/superpowers.ts`](https://github.com/obra/superpowers/blob/main/.pi/extensions/superpowers.ts)
extended with an internal `superpowersEnabled` flag (default: `false`) that
gates both skill discovery and the `using-superpowers` bootstrap injection.

## Behavior

- **Before `/superpowers`:** pi does not see or load any superpowers skills,
  and no bootstrap context is injected. Zero context overhead.
- **`/superpowers`:**
  1. On first use, creates a lean sparse checkout (`skills/` plus `LICENSE`
     and `RELEASE-NOTES.md`, `--filter=blob:none`) of the **latest release tag** of obra/superpowers
     at `~/.pi/agent/toggle-superpowers/superpowers` (reused afterwards; falls
     back to a plain shallow clone on old git versions).
  2. Sets `superpowersEnabled = true` and persists that decision into the
     current session.
  3. Reloads resources so the superpowers skills are discovered and the
     `using-superpowers` bootstrap is injected on the next agent run (same
     injection logic as upstream: once per session start and again after
     compaction).
- **Update notifications:** while superpowers are enabled, the extension
  checks (at most once per 24h, non-blocking, silent when offline) whether a
  newer release tag exists and shows a notification suggesting
  `/superpowers update`. Nothing is ever updated automatically.
- **No off-switch:** the flag cannot be turned off within the same session.
  It resets to `false` when a new session starts (`/new`). Resuming a session
  where `/superpowers` was activated (`/resume`) restores the enabled state,
  since it is persisted in the session file.
- **`/superpowers update`:** upgrades the clone to the latest release tag
  (also converts a legacy full clone to a sparse checkout).

## Install

```bash
pi install git:github.com/JulianS-Uni/toggle-superpowers
```

or, once published to npm:

```bash
pi install npm:toggle-superpowers
```

For local development, load the checkout directly:

```bash
pi -e /path/to/toggle-superpowers/extensions/toggle-superpowers.ts
```

> **Note:** don't install this alongside the upstream `obra/superpowers` pi
> package — upstream registers its skills and bootstrap unconditionally, which
> defeats the purpose of the gate.

## Usage

```
/superpowers          # enable superpowers for this session
/superpowers update   # upgrade the skills clone to the latest release
/new                  # start a new session -> superpowers disabled again
```

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # smoke test with a mocked ExtensionAPI (no network)
```

## License

MIT. Contains code derived from
[obra/superpowers](https://github.com/obra/superpowers) (MIT, © Jesse Vincent).
