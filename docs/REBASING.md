# Rebasing this fork on upstream

This is a fork of [czottmann/pi-automode](https://github.com/czottmann/pi-automode)
carrying one feature: auto mode can register as a link on
`@gotgenes/pi-permission-system`'s authorizer chain, so the two packages
compose instead of contending for pi's `tool_call` event.

The fork is kept deliberately additive, so upstream replays underneath it.

## What is ours

New files. Upstream has nothing at these paths, so a rebase never touches them.

- `extensions/auto-mode/permission-chain.ts`, the whole integration
- `tests/permission-chain.test.ts`, its tests
- `docs/REBASING.md`, this file

## What we edit upstream

One file, six lines, and both hunks are insertions:

| File | Our change |
| --- | --- |
| `extensions/auto-mode.ts` | one `export * from "./auto-mode/permission-chain.ts"`, one import, and `export default withPermissionChain(createPiAutomode())` in place of `export default createPiAutomode()` |

`package.json` is **never** modified, which keeps every upstream
`chore(release)` commit a clean replay. The Nix pin in
[pi-nix](https://github.com/joegoldin/pi-nix) carries the fork's version string
instead, so `package.json` and the npm registry stay upstream's.

Nothing under `extensions/auto-mode/` other than the new file is touched. In
particular `extension.ts`, which holds the decision pipeline, is upstream's
byte for byte: the wrapper intercepts the factory's `pi.on("tool_call", …)`
registration rather than editing the handler, and calls that same handler from
the chain link. That is the property worth protecting on every rebase. A
verdict the link returns and a verdict the standalone gate returns come from
one piece of code, so they cannot drift.

## Procedure

```bash
git fetch upstream
git rebase upstream/main
bun install          # dev dependencies only; the package has no runtime ones
npm test             # upstream's suite plus ours
npx tsc --noEmit
```

Expect a conflict only in `extensions/auto-mode.ts`, and only when upstream
adds a module to its own re-export block. Resolve by keeping **both** sides.

Then prove the fork is still additive:

```bash
git diff upstream/main --stat -- . ':!extensions/auto-mode.ts' \
  ':!extensions/auto-mode/permission-chain.ts' ':!tests/permission-chain.test.ts' \
  ':!docs/REBASING.md'
```

That must print nothing.

## What upstream could change that would need real work

- **Moving the `tool_call` registration out of the factory**, into a
  standalone export or behind a second `pi.on` call. The shim captures
  exactly one `tool_call` handler; a second registration would silently replace
  the first. `tests/permission-chain.test.ts` does not catch that, because the
  fake host it drives is ours.
- **Changing `ToolCallEventResult`** from `{ block, reason }`. The link maps
  `block` to a chain `deny` and everything else to `allow`.
- **Taking `input` apart differently**, a bash command read from somewhere
  other than `input.command`. The projection in `eventFromDetails` mirrors
  `getPrimaryArgument` and `extractInputPath`, and is used only for asks with
  no local tool call (a forwarded subagent ask, or a load order that puts the
  permission system first).

Changes on the *other* side of the seam are tracked in pi-nix's
`docs/assumption-a2.md`: the symbol slot name, the `registerAuthorizer`
signature, the `authorizerChain` config key, and the bounded-delegation
envelope that caps a link's `allow` on the `path` and `external_directory`
surfaces.
