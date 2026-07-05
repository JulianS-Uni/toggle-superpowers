# toogle-superpowers

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
  1. Clones `obra/superpowers` on first use to
     `~/.pi/agent/toogle-superpowers/superpowers` (reused afterwards, no
     auto-update).
  2. Sets `superpowersEnabled = true` and persists that decision into the
     current session.
  3. Reloads resources so the superpowers skills are discovered and the
     `using-superpowers` bootstrap is injected on the next agent run (same
     injection logic as upstream: once per session start and again after
     compaction).
- **No off-switch:** the flag cannot be turned off within the same session.
  It resets to `false` when a new session starts (`/new`). Resuming a session
  where `/superpowers` was activated (`/resume`) restores the enabled state,
  since it is persisted in the session file.
- **`/superpowers update`:** runs `git pull` on the existing clone.

## Install

```bash
pi install git:github.com/kluk/toogle-superpowers
```

or, once published to npm:

```bash
pi install npm:toogle-superpowers
```

For local development, load the checkout directly:

```bash
pi -e /path/to/toogle-superpowers/extensions/toogle-superpowers.ts
```

> **Note:** don't install this alongside the upstream `obra/superpowers` pi
> package — upstream registers its skills and bootstrap unconditionally, which
> defeats the purpose of the gate.

## Usage

```
/superpowers          # enable superpowers for this session
/superpowers update   # git pull the local superpowers clone
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
