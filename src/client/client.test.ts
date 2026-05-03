import { beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import type {
  DevvitStateUpdate,
  DevvitStateUpdatesSinceResult,
  DevvitStateSnapshot,
} from "../shared";
import { createDevvitStateClient } from "./index";

type RealtimeOptions = {
  channel: string;
  onMessage: (update: DevvitStateUpdate) => void;
};

type RealtimeMock = {
  connections: RealtimeOptions[];
  disconnectedChannels: string[];
};

const realtimeMock = vi.hoisted(
  (): RealtimeMock => ({
    connections: [],
    disconnectedChannels: [],
  }),
);

vi.mock("@devvit/web/client", () => ({
  connectRealtime: (options: RealtimeOptions) => {
    realtimeMock.connections.push(options);

    return {
      disconnect: async () => {},
    };
  },
  disconnectRealtime: (channel: string) => {
    realtimeMock.disconnectedChannels.push(channel);
  },
}));

const stateKey = "client:test-state";
const channel = "client-test-channel";
const testStateSchema = z.object({
  label: z.string(),
  numbers: z.array(z.number()),
});

type TestState = z.infer<typeof testStateSchema>;

beforeEach(() => {
  realtimeMock.connections = [];
  realtimeMock.disconnectedChannels = [];
});

describe("Devvit state client", () => {
  test("buffers realtime updates during startup and delivers contiguous updates", async () => {
    const snapshotDeferred = createDeferred<DevvitStateSnapshot<TestState>>();
    const updates: number[] = [];
    const client = createDevvitStateClient({
      key: stateKey,
      schema: testStateSchema,
      channel,
      fetchSnapshot: async () => await snapshotDeferred.promise,
      fetchUpdatesSince: async () => ({
        currentVersion: 1,
        updates: [addNumberUpdate(1, 1)],
        hasMore: false,
      }),
    });
    const subscriptionPromise = client.subscribe({
      onUpdate: ({ update }) => {
        updates.push(update.version);
      },
    });

    emitRealtime(addNumberUpdate(2, 2));
    snapshotDeferred.resolve(snapshot(0, []));

    const subscription = await subscriptionPromise;

    expect(updates).toEqual([1, 2]);

    subscription.unsubscribe();
  });

  test("fetches missing updates on a realtime gap before applying buffered updates", async () => {
    const updates: number[] = [];
    let fetchCount = 0;
    const fetchUpdatesSince = vi.fn(
      async (): Promise<DevvitStateUpdatesSinceResult> => {
        fetchCount += 1;

        if (fetchCount === 1) {
          return {
            currentVersion: 0,
            updates: [],
            hasMore: false,
          };
        }

        return {
          currentVersion: 6,
          updates: [
            addNumberUpdate(1, 1),
            addNumberUpdate(2, 2),
            addNumberUpdate(3, 3),
            addNumberUpdate(4, 4),
            addNumberUpdate(5, 5),
          ],
          hasMore: false,
        };
      },
    );
    const client = createDevvitStateClient({
      key: stateKey,
      schema: testStateSchema,
      channel,
      fetchSnapshot: async () => snapshot(0, []),
      fetchUpdatesSince,
    });
    const subscription = await client.subscribe({
      onUpdate: ({ update }) => {
        updates.push(update.version);
      },
    });

    emitRealtime(addNumberUpdate(6, 6));
    await waitFor(() => updates.length === 6);

    expect(updates).toEqual([1, 2, 3, 4, 5, 6]);

    subscription.unsubscribe();
  });

  test("falls back to snapshot resync when missing updates are unavailable", async () => {
    const resyncVersions: number[] = [];
    const snapshots = [snapshot(2, [1, 2]), snapshot(5, [1, 2, 3, 4, 5])];
    let snapshotIndex = 0;
    const client = createDevvitStateClient({
      key: stateKey,
      schema: testStateSchema,
      channel,
      fetchSnapshot: async () => {
        const nextSnapshot = snapshots[snapshotIndex];

        if (!nextSnapshot) {
          throw new Error("Missing test snapshot.");
        }

        snapshotIndex += 1;
        return nextSnapshot;
      },
      fetchUpdatesSince: async () => ({
        currentVersion: 5,
        updates: [],
        hasMore: false,
      }),
    });
    const subscription = await client.subscribe({
      onResync: ({ snapshot: nextSnapshot }) => {
        resyncVersions.push(nextSnapshot.version);
      },
    });

    emitRealtime(addNumberUpdate(5, 5));
    await waitFor(() => resyncVersions.length === 1);

    expect(resyncVersions).toEqual([5]);

    subscription.unsubscribe();
  });

  test("ignores duplicate and stale realtime updates", async () => {
    const updates: number[] = [];
    const client = createDevvitStateClient({
      key: stateKey,
      schema: testStateSchema,
      channel,
      fetchSnapshot: async () => snapshot(1, [1]),
      fetchUpdatesSince: async () => ({
        currentVersion: 1,
        updates: [],
        hasMore: false,
      }),
    });
    const subscription = await client.subscribe({
      onUpdate: ({ update }) => {
        updates.push(update.version);
      },
    });

    emitRealtime(addNumberUpdate(1, 1));
    emitRealtime(addNumberUpdate(2, 2));
    await waitFor(() => updates.length === 1);

    expect(updates).toEqual([2]);

    subscription.unsubscribe();
  });
});

const snapshot = (
  version: number,
  numbers: number[],
): DevvitStateSnapshot<TestState> => {
  return {
    version,
    state: {
      label: "ready",
      numbers,
    },
    updatedAtMs: version,
  };
};

const addNumberUpdate = (version: number, value: number): DevvitStateUpdate => {
  return {
    stateKey,
    updateId: `${stateKey}:${version}`,
    version,
    patches: [
      {
        op: "add",
        path: "/numbers/-",
        value,
      },
    ],
    createdAtMs: version,
  };
};

const emitRealtime = (update: DevvitStateUpdate): void => {
  const connection = realtimeMock.connections.at(-1);

  if (!connection) {
    throw new Error("No realtime connection.");
  }

  connection.onMessage(update);
};

type Deferred<Value> = {
  promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: unknown): void;
};

const createDeferred = <Value>(): Deferred<Value> => {
  let resolveDeferred: ((value: Value) => void) | null = null;
  let rejectDeferred: ((error: unknown) => void) | null = null;
  const promise = new Promise<Value>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });

  if (!resolveDeferred || !rejectDeferred) {
    throw new Error("Unable to create deferred promise.");
  }

  return {
    promise,
    resolve: resolveDeferred,
    reject: rejectDeferred,
  };
};

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) {
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  throw new Error("Timed out waiting for condition.");
};
