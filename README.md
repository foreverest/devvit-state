# devvit-state

Atomic, versioned state sync for Devvit apps.

`devvit-state` manages Zod-typed JSON state with Redis transactions, strict versions, bounded update replay, and Devvit Realtime broadcasts. It is designed for Devvit web apps that need a shared authoritative state with reliable client synchronization.

## Install

```sh
npm install devvit-state zod
```

`devvit-state` expects to run inside a Devvit app and uses `@devvit/web/server` for Redis and Realtime on the server and `@devvit/web/client` for Realtime subscriptions on the client.

## Compatibility

- Devvit: `@devvit/web >=0.12.0-0 <0.13.0`
- Zod: `^4.0.0`
- Runtime: Devvit web apps running on Node.js 22+
- Module format: ESM

Enable Realtime in `devvit.json`:

```json
{
  "permissions": {
    "realtime": true
  }
}
```

## Entry Points

Use runtime-specific imports so server-only Devvit APIs do not end up in client bundles.

```ts
import { createDevvitState } from "devvit-state/server";
import { createDevvitStateClient } from "devvit-state/client";
import type { DevvitStateUpdate } from "devvit-state/shared";
```

## Concepts

- **Snapshot**: a versioned point-in-time state value: `{ version, state, updatedAtMs }`.
- **Update**: one committed atomic mutation with one version and one or more patches.
- **Patch**: one JSON Patch-style operation inside an update.

The current snapshot is the source of truth. The update log is bounded and exists so clients can recover missed Realtime messages without immediately resyncing the whole state.

## Server Usage

```ts
import { createDevvitState } from "devvit-state/server";
import { z } from "zod";

const roomStateSchema = z.object({
  title: z.string(),
  users: z.array(z.string()),
});

const roomState = createDevvitState({
  key: `room:${postId}`,
  schema: roomStateSchema,
  defaultValue: () => ({
    title: "Lobby",
    users: [],
  }),
});

await roomState.initialize();

const current = await roomState.getCurrent();

const update = await roomState.mutate((draft) => {
  draft.users.push(userId);
});

const missingUpdates = await roomState.getUpdatesSince({
  sinceVersion: current?.version ?? 0,
});
```

For lower-level callers, `patch()` applies explicit JSON Pointer patches:

```ts
await roomState.patch([
  {
    op: "add",
    path: "/users/-",
    value: userId,
  },
]);
```

Mutation producers may run more than once after Redis transaction conflicts. Keep producers deterministic and free of external side effects.

## Client Usage

The client API connects to Realtime, fetches a baseline snapshot, replays missing updates, and only delivers contiguous updates to application code.

```ts
import { createDevvitStateClient } from "devvit-state/client";
import { z } from "zod";

const roomStateSchema = z.object({
  title: z.string(),
  users: z.array(z.string()),
});

const key = `room:${postId}`;

const clientState = createDevvitStateClient({
  key,
  schema: roomStateSchema,
  fetchSnapshot: async () => await trpc.roomState.current.query(),
  fetchUpdatesSince: async (input) =>
    await trpc.roomState.updatesSince.query(input),
});

const subscription = await clientState.subscribe({
  onReady({ snapshot }) {
    render(snapshot.state);
  },
  onUpdate({ update, state, previousState }) {
    for (const patch of update.patches) {
      console.log("Applied patch:", patch);
    }

    render(state, previousState);
  },
  onResync({ snapshot }) {
    console.warn("State resynced");
    render(snapshot.state);
  },
  onError(error) {
    console.error("State sync failed:", error);
  },
});

subscription.unsubscribe();
```

The transport is app-owned. Wire `getCurrent()` and `getUpdatesSince()` through tRPC, Hono, or whichever server route style your Devvit app already uses.

## API Summary

Server:

```ts
const state = createDevvitState({
  key,
  schema,
  defaultValue,
  maxUpdates: 1000,
  maxUpdateFetchLimit: 500,
});

await state.initialize();
await state.getCurrent();
await state.getUpdatesSince({ sinceVersion, limit });
await state.mutate((draft) => {});
await state.patch([{ op: "replace", path: "/title", value: "New title" }]);
```

Client:

```ts
const client = createDevvitStateClient({
  key,
  schema,
  fetchSnapshot,
  fetchUpdatesSince,
});

const subscription = await client.subscribe({
  onReady,
  onUpdate,
  onResync,
  onError,
});
```

Shared:

```ts
applyDevvitStatePatches(state, update.patches);
createDevvitStatePatches(previousState, nextState);
```

## Notes

- State values must be JSON-compatible and accepted by the provided Zod schema.
- `initialize()` writes version `0` only when the state is missing.
- `mutate()` and `patch()` return `null` when no state change is produced.
- Realtime messages may be dropped, duplicated, delayed, or reordered; clients treat Realtime as a fast path and recover with `fetchUpdatesSince`.
- If the bounded update log no longer contains the missing update, the client fetches a fresh snapshot and calls `onResync`.
