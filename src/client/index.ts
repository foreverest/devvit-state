import { connectRealtime, disconnectRealtime } from "@devvit/web/client";
import type { ZodType } from "zod";
import {
  applyDevvitStatePatches,
  createDevvitStateSnapshotSchema,
  createDevvitStateValueSchema,
  devvitStateJsonValueSchema,
  devvitStateUpdateSchema,
  devvitStateUpdatesSinceResultSchema,
  type DevvitStateUpdate,
  type DevvitStateUpdatesSinceResult,
  type DevvitStateSnapshot,
} from "../shared";

export { getDevvitStateRealtimeChannel } from "../shared";

/**
 * Options for creating a client-side Devvit state subscriber.
 */
export type CreateDevvitStateClientOptions<State> = {
  /** Unique application-level key matching the server state key. */
  key: string;
  /** Zod schema used to validate snapshots and applied updates. */
  schema: ZodType<State>;
  /** Realtime channel where server updates are broadcast. */
  channel: string;
  /** Fetches the baseline snapshot through app-owned transport. */
  fetchSnapshot: () => Promise<DevvitStateSnapshot<State>>;
  /** Fetches committed updates after a known version through app-owned transport. */
  fetchUpdatesSince: (
    input: DevvitStateClientUpdatesSinceInput,
  ) => Promise<DevvitStateUpdatesSinceResult>;
  /** Maximum number of updates requested in one replay call. */
  maxUpdateFetchLimit?: number;
};

/**
 * Input passed to `fetchUpdatesSince`.
 */
export type DevvitStateClientUpdatesSinceInput = {
  /** Last version already known by the client. */
  sinceVersion: number;
  /** Requested update count, capped by the server implementation. */
  limit?: number;
};

/**
 * Payload delivered when the client has loaded its baseline snapshot.
 */
export type DevvitStateClientReadyInput<State> = {
  /** Baseline snapshot used before incremental updates are delivered. */
  snapshot: DevvitStateSnapshot<State>;
};

/**
 * Payload delivered for each committed update applied by the client.
 */
export type DevvitStateClientUpdateInput<State> = {
  /** Committed update that advanced the local state by one version. */
  update: DevvitStateUpdate;
  /** State after applying the update. */
  state: State;
  /** State before applying the update. */
  previousState: State;
};

/**
 * Payload delivered when the client cannot replay missing updates and reloads a snapshot.
 */
export type DevvitStateClientResyncInput<State> = {
  /** Fresh snapshot that replaced the client's local state. */
  snapshot: DevvitStateSnapshot<State>;
};

/**
 * Callback set for a Devvit state subscription.
 */
export type DevvitStateClientSubscribeOptions<State> = {
  /** Called once after the baseline snapshot is loaded. */
  onReady?: (input: DevvitStateClientReadyInput<State>) => void;
  /** Called for each contiguous update applied to local state. */
  onUpdate?: (input: DevvitStateClientUpdateInput<State>) => void;
  /** Called when the client reloads a full snapshot after replay is unavailable. */
  onResync?: (input: DevvitStateClientResyncInput<State>) => void;
  /** Called when snapshot, replay, Realtime, or patch validation fails. */
  onError?: (error: unknown) => void;
};

/**
 * Active client state subscription.
 */
export type DevvitStateSubscription = {
  /** Stops Realtime delivery and clears buffered updates. */
  unsubscribe(): void;
};

/**
 * Client-side API for subscribing to one keyed Devvit state object.
 */
export type DevvitStateClient<State> = {
  /** Starts Realtime, loads a baseline snapshot, replays gaps, and delivers updates. */
  subscribe(
    callbacks?: DevvitStateClientSubscribeOptions<State>,
  ): Promise<DevvitStateSubscription>;
};

const defaultMaxUpdateFetchLimit = 500;

/**
 * Creates a client-side subscriber for Zod-typed Devvit state.
 */
export const createDevvitStateClient = <State>({
  key,
  schema,
  channel,
  fetchSnapshot,
  fetchUpdatesSince,
  maxUpdateFetchLimit = defaultMaxUpdateFetchLimit,
}: CreateDevvitStateClientOptions<State>): DevvitStateClient<State> => {
  if (!Number.isSafeInteger(maxUpdateFetchLimit) || maxUpdateFetchLimit < 1) {
    throw new Error("maxUpdateFetchLimit must be a positive safe integer.");
  }

  const stateSchema = createDevvitStateValueSchema(schema);
  const snapshotSchema = createDevvitStateSnapshotSchema(schema);

  const subscribe = async (
    callbacks: DevvitStateClientSubscribeOptions<State> = {},
  ): Promise<DevvitStateSubscription> => {
    let currentSnapshot: DevvitStateSnapshot<State> | null = null;
    let knownCurrentVersion = 0;
    let isUnsubscribed = false;
    let isDraining = false;
    let shouldDrainAgain = false;
    // Tracks the highest version observed through either Realtime or replay.
    // Pending updates are only delivered once every preceding version is known.
    const pendingUpdatesByVersion = new Map<number, DevvitStateUpdate>();

    const enqueueUpdate = (update: DevvitStateUpdate): void => {
      if (update.stateKey !== key) {
        return;
      }

      knownCurrentVersion = Math.max(knownCurrentVersion, update.version);

      if (currentSnapshot && update.version <= currentSnapshot.version) {
        return;
      }

      pendingUpdatesByVersion.set(update.version, update);

      if (currentSnapshot) {
        scheduleDrain();
      }
    };

    const scheduleDrain = (): void => {
      shouldDrainAgain = true;

      if (!isDraining) {
        void drainQueuedUpdates();
      }
    };

    const loadSnapshot = async (
      shouldNotifyResync: boolean,
    ): Promise<DevvitStateSnapshot<State>> => {
      const snapshot = snapshotSchema.parse(await fetchSnapshot());

      currentSnapshot = snapshot;

      if (shouldNotifyResync) {
        // After a full resync, pending updates may belong to the abandoned
        // version chain. Drop them and let future Realtime/replay rebuild order.
        pendingUpdatesByVersion.clear();
        knownCurrentVersion = snapshot.version;
      } else {
        knownCurrentVersion = Math.max(knownCurrentVersion, snapshot.version);

        for (const version of pendingUpdatesByVersion.keys()) {
          if (version <= snapshot.version) {
            pendingUpdatesByVersion.delete(version);
          }
        }
      }

      if (shouldNotifyResync) {
        callbacks.onResync?.({ snapshot });
      } else {
        callbacks.onReady?.({ snapshot });
      }

      return snapshot;
    };

    const fetchAndQueueUpdatesSince = async (
      sinceVersion: number,
    ): Promise<void> => {
      const response = devvitStateUpdatesSinceResultSchema.parse(
        await fetchUpdatesSince({
          sinceVersion,
          limit: maxUpdateFetchLimit,
        }),
      );

      knownCurrentVersion = Math.max(
        knownCurrentVersion,
        response.currentVersion,
      );

      for (const update of response.updates) {
        enqueueUpdate(update);
      }
    };

    const drainQueuedUpdates = async (): Promise<void> => {
      if (isDraining || isUnsubscribed) {
        return;
      }

      isDraining = true;

      try {
        while (shouldDrainAgain && !isUnsubscribed) {
          shouldDrainAgain = false;
          await drainQueuedUpdatesOnce();
        }
      } catch (error) {
        callbacks.onError?.(error);
      } finally {
        isDraining = false;
      }

      if (shouldDrainAgain && !isUnsubscribed) {
        scheduleDrain();
      }
    };

    const drainQueuedUpdatesOnce = async (): Promise<void> => {
      while (currentSnapshot && !isUnsubscribed) {
        const nextVersion = currentSnapshot.version + 1;
        const nextUpdate = pendingUpdatesByVersion.get(nextVersion);

        if (nextUpdate) {
          pendingUpdatesByVersion.delete(nextVersion);
          applyUpdate(nextUpdate);
          continue;
        }

        if (knownCurrentVersion > currentSnapshot.version) {
          await recoverGap();
          continue;
        }

        break;
      }
    };

    const recoverGap = async (): Promise<void> => {
      const snapshot = currentSnapshot;

      if (!snapshot) {
        return;
      }

      const previousVersion = snapshot.version;

      await fetchAndQueueUpdatesSince(previousVersion);

      const firstRecoveredUpdate = pendingUpdatesByVersion.get(
        previousVersion + 1,
      );

      if (
        knownCurrentVersion > previousVersion &&
        firstRecoveredUpdate === undefined
      ) {
        await loadSnapshot(true);
      }
    };

    const applyUpdate = (update: DevvitStateUpdate): void => {
      const snapshot = currentSnapshot;

      if (!snapshot || update.version !== snapshot.version + 1) {
        return;
      }

      const previousState = snapshot.state;
      const nextState = stateSchema.parse(
        applyDevvitStatePatches(
          devvitStateJsonValueSchema.parse(previousState),
          update.patches,
        ),
      );
      const nextSnapshot: DevvitStateSnapshot<State> = {
        version: update.version,
        state: nextState,
        updatedAtMs: update.createdAtMs,
      };

      currentSnapshot = nextSnapshot;
      callbacks.onUpdate?.({
        update,
        state: nextState,
        previousState,
      });
    };

    // Subscribe before fetching the snapshot. Incoming updates are buffered so
    // the first update delivered to app code is snapshot.version + 1.
    connectRealtime<DevvitStateUpdate>({
      channel,
      onMessage: (update) => {
        const result = devvitStateUpdateSchema.safeParse(update);

        if (result.success) {
          enqueueUpdate(result.data);
        } else {
          callbacks.onError?.(result.error);
        }
      },
    });

    try {
      const readySnapshot = await loadSnapshot(false);
      await fetchAndQueueUpdatesSince(readySnapshot.version);
      shouldDrainAgain = true;
      await drainQueuedUpdates();
    } catch (error) {
      disconnectRealtime(channel);
      callbacks.onError?.(error);
      throw error;
    }

    return {
      unsubscribe(): void {
        isUnsubscribed = true;
        pendingUpdatesByVersion.clear();
        disconnectRealtime(channel);
      },
    };
  };

  return {
    subscribe,
  };
};
