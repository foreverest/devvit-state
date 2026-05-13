# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

- `npm run test` — run the Vitest suite (`vitest run`). For a single file: `npx vitest run src/server/state.test.ts`. For a focused test, `.only` in source or `-t "<name>"` on the CLI.
- `npm run type-check` — type-checks the three project tsconfigs (`shared`, `server`, `client`) separately. Always run all three; a change in `src/shared` must satisfy both server and client compilation contexts.
- `npm run lint` — ESLint over `src/**/*.{ts,tsx}` using three layered configs (server / client / shared) that each point at their matching tsconfig.
- `npm run build` — wipes `dist/` and emits three separate builds (`shared`, then `server`, then `client`) into `dist/<layer>/`. Order matters: server and client both depend on the shared output type files.
- `npm run test:consumer` — builds the package and type-checks `test/consumer/index.ts` against the published `exports` map. Run this after changing public types or the `exports` field in `package.json` to confirm downstream consumers still resolve `devvit-state/server`, `/client`, and `/shared`.
- `npm run ci` — full local CI gate: type-check, lint, test, build, consumer test, `npm pack --dry-run`. This is what `prepublishOnly` runs.
- `npm run prettier` — formats the entire repo. There is no separate `prettier:check` script.

Node 22+ and ESM only. The package's own `"type": "module"` and the `Bundler` module resolution in `tsconfig.base.json` mean **all relative imports must include the `.js` extension** (even when importing from a `.ts` file).

## Architecture

This is a publishable npm library (`devvit-state`) that provides atomic, versioned, Zod-typed state synchronization for Devvit web apps. It is split into three runtime layers, each a separate `exports` entry:

- **`src/shared/`** — pure JSON / patch / schema utilities and types. Safe for both server and client bundles. Has no Devvit imports. Includes the JSON-Patch-style differ/applier (`patches.ts`) and all Zod schemas (`schemas.ts`).
- **`src/server/`** — Node-only. Imports `@devvit/web/server` for Redis + Realtime. Owns the authoritative state via `createDevvitState`. All mutation goes through `commitMutation`, which uses Redis `WATCH`/`MULTI`/`EXEC` with up to `maxCommitAttempts` retries; the mutation producer may run multiple times so it must be deterministic and side-effect-free.
- **`src/client/`** — Browser-only. Imports `@devvit/web/client` for Realtime. `createDevvitStateClient` subscribes to Realtime, then loads a baseline snapshot, then replays gaps via app-supplied `fetchUpdatesSince` / `fetchSnapshot` callbacks (the transport itself is owned by the consuming app, e.g. tRPC or Hono routes).

### Storage layout (server)

For state key `K`, three Redis keys are used: `devvit-state:K:version` (counter), `devvit-state:K:snapshot` (current JSON), and `devvit-state:K:updates` (sorted set of recent updates, scored by version, trimmed to `maxUpdates`). The current snapshot is the source of truth; the updates log is bounded and exists purely so clients can replay missed Realtime messages without resyncing the whole state.

### Client ordering invariants

The client is responsible for delivering only contiguous updates to app code:

- It connects Realtime _before_ fetching the snapshot, so any in-flight updates are buffered.
- `pendingUpdatesByVersion` is the buffer; `knownCurrentVersion` tracks the highest version seen via either Realtime or replay.
- If a Realtime message arrives with a gap, `recoverGap` calls `fetchUpdatesSince`. If even that comes back empty for the missing version, the client falls back to a fresh `fetchSnapshot` and emits `onResync` instead of `onUpdate`.
- Realtime is treated as a fast path that may drop, duplicate, delay, or reorder. Correctness is provided by the version chain + replay, not by Realtime.

### Schema validation boundary

Caller-supplied Zod schemas are wrapped by `createDevvitStateValueSchema`, which adds a `.refine` that the value is JSON-compatible. State is re-parsed at every boundary: after `mutate` produces a new draft, after applying patches, on read from Redis, and on receipt at the client. Patches themselves are validated with `devvitStatePatchSchema` (a discriminated union over `add`/`replace`/`remove`).

### TypeScript build setup

There is one `tsconfig.base.json` and then six per-purpose configs:

- `tsconfig.{shared,server,client}.json` — `noEmit`, used by `type-check` and ESLint.
- `tsconfig.build.{shared,server,client}.json` — emit to `dist/<layer>/`, used by `build`.

The server config sets `exactOptionalPropertyTypes: false` (the others leave the strict default on); keep that in mind when editing types that cross layers.

## Testing notes

- Server tests use `createDevvitTest` from `@devvit/test/server/vitest`, which spins up a Devvit-style Redis + Realtime environment per test. `devvitTest(...)` is the per-test wrapper — use it instead of plain `test(...)` for any test that touches Redis or Realtime.
- Tests inject deterministic `now: () => 123_000` and rely on the real Devvit Redis from the test harness, not mocks.
- `test/consumer/` is a _type-only_ smoke test that imports the package by its public name to verify the `exports` map and `.d.ts` outputs — it does not run any code.
