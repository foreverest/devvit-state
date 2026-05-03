import { realtime, redis as defaultRedis } from "@devvit/web/server";
import type { ZodType } from "zod";
import {
  applyDevvitStatePatches,
  cloneDevvitStateJson,
  createDevvitStatePatches,
  createDevvitStateSnapshotSchema,
  createDevvitStateValueSchema,
  devvitStateJsonValueSchema,
  devvitStateUpdateSchema,
  getDevvitStateRealtimeChannel,
  type DevvitStateUpdate,
  type DevvitStateUpdatesSinceResult,
  type DevvitStatePatch,
  type DevvitStateSnapshot,
} from "../shared/index.js";

export { getDevvitStateRealtimeChannel } from "../shared/index.js";

type RedisSortedSetMember = {
  member: string;
  score: number;
};

type DevvitStateRedis = {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<unknown>;
  watch(...keys: string[]): Promise<DevvitStateRedisTransaction>;
  incrBy(key: string, value: number): Promise<number>;
  zRange(
    key: string,
    start: number | string,
    stop: number | string,
    options?: {
      by: "score" | "lex" | "rank";
      limit?: {
        offset: number;
        count: number;
      };
    },
  ): Promise<RedisSortedSetMember[]>;
};

type DevvitStateRedisTransaction = {
  multi(): Promise<void>;
  exec(): Promise<unknown[]>;
  discard(): Promise<void>;
  set(key: string, value: string): Promise<unknown>;
  incrBy(key: string, value: number): Promise<unknown>;
  zAdd(key: string, ...members: RedisSortedSetMember[]): Promise<unknown>;
  zRemRangeByRank(key: string, start: number, stop: number): Promise<unknown>;
};

type DevvitStateRealtime = {
  send(channel: string, update: DevvitStateUpdate): Promise<void>;
};

type DevvitStateStorageKeys = {
  version: string;
  snapshot: string;
  updates: string;
};

/**
 * Options for creating a server-side Devvit state manager.
 */
export type CreateDevvitStateOptions<State> = {
  /** Unique application-level key for this state instance. */
  key: string;
  /** Zod schema used to validate snapshots, mutations, and patch results. */
  schema: ZodType<State>;
  /** Initial value used by `initialize()` when no snapshot exists yet. */
  defaultValue?: () => State;
  /** Realtime channel used for committed updates. Defaults from the state key. */
  channel?: string;
  /** Maximum number of recent updates kept for client replay. */
  maxUpdates?: number;
  /** Maximum number of updates returned by one replay query. */
  maxUpdateFetchLimit?: number;
  /** Clock hook, primarily useful for deterministic tests. */
  now?: () => number;
  /** Redis client override, primarily useful for tests. */
  redis?: DevvitStateRedis;
  /** Realtime client override, primarily useful for tests. */
  realtime?: DevvitStateRealtime;
};

/**
 * Input for reading recent committed updates after a known version.
 */
export type DevvitStateUpdatesSinceInput = {
  /** Last version already known by the caller. */
  sinceVersion: number;
  /** Optional result limit, capped by `maxUpdateFetchLimit`. */
  limit?: number;
};

/**
 * Producer used by `mutate()`.
 *
 * The producer may run more than once after Redis transaction conflicts. Keep it
 * deterministic and free of external side effects.
 */
export type DevvitStateMutationProducer<State> = (draft: State) => void;

/**
 * Server-side API for one keyed Devvit state object.
 */
export type DevvitState<State> = {
  /** Unique application-level key for this state instance. */
  readonly key: string;
  /** Realtime channel where committed updates are broadcast. */
  readonly channel: string;
  /** Creates version 0 if no snapshot exists, otherwise returns the existing snapshot. */
  initialize(): Promise<DevvitStateSnapshot<State>>;
  /** Reads the current authoritative snapshot, or `null` if uninitialized. */
  getCurrent(): Promise<DevvitStateSnapshot<State> | null>;
  /** Reads bounded recent updates after `sinceVersion` for client replay. */
  getUpdatesSince(
    input: DevvitStateUpdatesSinceInput,
  ): Promise<DevvitStateUpdatesSinceResult>;
  /** Atomically mutates state with an ergonomic producer callback. */
  mutate(
    producer: DevvitStateMutationProducer<State>,
  ): Promise<DevvitStateUpdate | null>;
  /** Atomically applies explicit JSON Patch-style operations. */
  patch(
    patches: readonly DevvitStatePatch[],
  ): Promise<DevvitStateUpdate | null>;
};

const defaultMaxUpdates = 1_000;
const defaultMaxUpdateFetchLimit = 500;
const maxCommitAttempts = 5;

/**
 * Creates a server-side manager for Zod-typed atomic Devvit state.
 */
export const createDevvitState = <State>({
  key,
  schema,
  defaultValue,
  channel = getDevvitStateRealtimeChannel(key),
  maxUpdates = defaultMaxUpdates,
  maxUpdateFetchLimit = defaultMaxUpdateFetchLimit,
  now = Date.now,
  redis = defaultRedis,
  realtime: realtimeClient = realtime,
}: CreateDevvitStateOptions<State>): DevvitState<State> => {
  if (!Number.isSafeInteger(maxUpdates) || maxUpdates < 1) {
    throw new Error("maxUpdates must be a positive safe integer.");
  }

  if (!Number.isSafeInteger(maxUpdateFetchLimit) || maxUpdateFetchLimit < 1) {
    throw new Error("maxUpdateFetchLimit must be a positive safe integer.");
  }

  const storageKeys = getDevvitStateStorageKeys(key);
  const stateSchema = createDevvitStateValueSchema(schema);
  const snapshotSchema = createDevvitStateSnapshotSchema(schema);

  const initialize = async (): Promise<DevvitStateSnapshot<State>> => {
    for (let attempt = 0; attempt < maxCommitAttempts; attempt += 1) {
      // Watch the snapshot key so two first-time initializers do not both create
      // different version-zero records.
      const transaction = await redis.watch(storageKeys.snapshot);
      let shouldDiscard = true;

      try {
        const existingSnapshot = await readStoredSnapshot({
          redis,
          snapshotKey: storageKeys.snapshot,
          snapshotSchema,
        });

        if (existingSnapshot) {
          await discardTransaction(transaction);
          shouldDiscard = false;
          return existingSnapshot;
        }

        const defaultState = stateSchema.parse(
          defaultValue ? defaultValue() : {},
        );
        const snapshot: DevvitStateSnapshot<State> = {
          version: 0,
          state: structuredClone(defaultState),
          updatedAtMs: now(),
        };

        await transaction.multi();
        await transaction.set(storageKeys.version, "0");
        await transaction.set(storageKeys.snapshot, JSON.stringify(snapshot));

        const results = await transaction.exec();
        shouldDiscard = false;

        if (results.length > 0) {
          return snapshot;
        }
      } catch (error) {
        if (shouldDiscard) {
          await discardTransaction(transaction);
        }

        throw error;
      }
    }

    throw new Error(`Failed to initialize state ${key}.`);
  };

  const getCurrent = async (): Promise<DevvitStateSnapshot<State> | null> => {
    return readStoredSnapshot({
      redis,
      snapshotKey: storageKeys.snapshot,
      snapshotSchema,
    });
  };

  const getUpdatesSince = async ({
    sinceVersion,
    limit = maxUpdateFetchLimit,
  }: DevvitStateUpdatesSinceInput): Promise<DevvitStateUpdatesSinceResult> => {
    if (!Number.isSafeInteger(sinceVersion) || sinceVersion < 0) {
      throw new Error("sinceVersion must be a non-negative safe integer.");
    }

    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("limit must be a positive safe integer.");
    }

    const boundedLimit = Math.min(limit, maxUpdateFetchLimit);
    const currentVersion = await readCurrentVersion(redis, storageKeys.version);
    const entries = await redis.zRange(
      storageKeys.updates,
      sinceVersion + 1,
      currentVersion,
      {
        by: "score",
        limit: {
          offset: 0,
          count: boundedLimit,
        },
      },
    );
    const updates = entries
      .map((entry) => parseStoredUpdate(entry.member))
      .filter(
        (update) => update.stateKey === key && update.version > sinceVersion,
      )
      .sort((left, right) => left.version - right.version);
    const lastUpdate = updates.at(-1);

    return {
      currentVersion,
      updates,
      hasMore: Boolean(lastUpdate && lastUpdate.version < currentVersion),
    };
  };

  const mutate = async (
    producer: DevvitStateMutationProducer<State>,
  ): Promise<DevvitStateUpdate | null> => {
    return commitMutation({
      key,
      channel,
      redis,
      realtime: realtimeClient,
      storageKeys,
      stateSchema,
      snapshotSchema,
      maxUpdates,
      now,
      getPatches: (snapshot) => {
        const nextState = structuredClone(snapshot.state);

        producer(nextState);

        const validatedNextState = stateSchema.parse(nextState);

        return createDevvitStatePatches(
          devvitStateJsonValueSchema.parse(snapshot.state),
          devvitStateJsonValueSchema.parse(validatedNextState),
        );
      },
    });
  };

  const patch = async (
    patches: readonly DevvitStatePatch[],
  ): Promise<DevvitStateUpdate | null> => {
    return commitMutation({
      key,
      channel,
      redis,
      realtime: realtimeClient,
      storageKeys,
      stateSchema,
      snapshotSchema,
      maxUpdates,
      now,
      getPatches: (snapshot) => {
        const nextState = stateSchema.parse(
          applyDevvitStatePatches(
            devvitStateJsonValueSchema.parse(snapshot.state),
            patches,
          ),
        );

        return createDevvitStatePatches(
          devvitStateJsonValueSchema.parse(snapshot.state),
          devvitStateJsonValueSchema.parse(nextState),
        );
      },
    });
  };

  return {
    key,
    channel,
    initialize,
    getCurrent,
    getUpdatesSince,
    mutate,
    patch,
  };
};

const commitMutation = async <State>({
  key,
  channel,
  redis,
  realtime,
  storageKeys,
  stateSchema,
  snapshotSchema,
  maxUpdates,
  now,
  getPatches,
}: {
  key: string;
  channel: string;
  redis: DevvitStateRedis;
  realtime: DevvitStateRealtime;
  storageKeys: DevvitStateStorageKeys;
  stateSchema: ZodType<State>;
  snapshotSchema: ZodType<DevvitStateSnapshot<State>>;
  maxUpdates: number;
  now: () => number;
  getPatches: (
    snapshot: DevvitStateSnapshot<State>,
  ) => readonly DevvitStatePatch[];
}): Promise<DevvitStateUpdate | null> => {
  for (let attempt = 0; attempt < maxCommitAttempts; attempt += 1) {
    // The producer is evaluated after WATCH so transaction conflicts rerun the
    // mutation against the newest committed snapshot.
    const transaction = await redis.watch(storageKeys.version);
    let shouldDiscard = true;

    try {
      const snapshot = await readStoredSnapshot({
        redis,
        snapshotKey: storageKeys.snapshot,
        snapshotSchema,
      });

      if (!snapshot) {
        throw new Error(`State ${key} is not initialized.`);
      }

      const currentVersion = await readCurrentVersion(
        redis,
        storageKeys.version,
      );

      if (currentVersion !== snapshot.version) {
        throw new Error(`State ${key} has inconsistent Redis version records.`);
      }

      const patches = getPatches(snapshot).map(cloneDevvitStatePatch);

      if (patches.length === 0) {
        await discardTransaction(transaction);
        shouldDiscard = false;
        return null;
      }

      const nextState = stateSchema.parse(
        applyDevvitStatePatches(
          devvitStateJsonValueSchema.parse(snapshot.state),
          patches,
        ),
      );
      const nextVersion = currentVersion + 1;
      const updatedAtMs = now();
      const nextSnapshot: DevvitStateSnapshot<State> = {
        version: nextVersion,
        state: nextState,
        updatedAtMs,
      };
      const update: DevvitStateUpdate = {
        stateKey: key,
        updateId: `${key}:${nextVersion}`,
        version: nextVersion,
        patches,
        createdAtMs: updatedAtMs,
      };

      await transaction.multi();
      await transaction.incrBy(storageKeys.version, 1);
      await transaction.set(storageKeys.snapshot, JSON.stringify(nextSnapshot));
      await transaction.zAdd(storageKeys.updates, {
        member: JSON.stringify(update),
        score: update.version,
      });
      await transaction.zRemRangeByRank(
        storageKeys.updates,
        0,
        -(maxUpdates + 1),
      );

      const results = await transaction.exec();
      shouldDiscard = false;

      if (results[0] === nextVersion) {
        // Realtime is a fast path only. If broadcast fails, clients can still
        // recover from the committed update log.
        await broadcastUpdate(realtime, channel, update);
        return update;
      }
    } catch (error) {
      if (shouldDiscard) {
        await discardTransaction(transaction);
      }

      throw error;
    }
  }

  throw new Error(`Failed to commit state ${key}.`);
};

const cloneDevvitStatePatch = (patch: DevvitStatePatch): DevvitStatePatch => {
  if (patch.op === "remove") {
    return {
      op: patch.op,
      path: patch.path,
    };
  }

  return {
    op: patch.op,
    path: patch.path,
    value: cloneDevvitStateJson(patch.value),
  };
};

const broadcastUpdate = async (
  realtimeClient: DevvitStateRealtime,
  channel: string,
  update: DevvitStateUpdate,
): Promise<void> => {
  try {
    await realtimeClient.send(channel, update);
  } catch (error) {
    console.error("Failed to broadcast Devvit state update:", error);
  }
};

const readStoredSnapshot = async <State>({
  redis,
  snapshotKey,
  snapshotSchema,
}: {
  redis: Pick<DevvitStateRedis, "get">;
  snapshotKey: string;
  snapshotSchema: ZodType<DevvitStateSnapshot<State>>;
}): Promise<DevvitStateSnapshot<State> | null> => {
  const snapshotRecord = await redis.get(snapshotKey);

  if (!snapshotRecord) {
    return null;
  }

  return snapshotSchema.parse(parseJsonRecord(snapshotRecord));
};

const readCurrentVersion = async (
  redis: Pick<DevvitStateRedis, "get">,
  versionKey: string,
): Promise<number> => {
  const versionRecord = await redis.get(versionKey);

  if (versionRecord === undefined) {
    return 0;
  }

  const version = Number(versionRecord);

  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error(`Invalid Devvit state version record at ${versionKey}.`);
  }

  return version;
};

const parseStoredUpdate = (record: string): DevvitStateUpdate => {
  return devvitStateUpdateSchema.parse(parseJsonRecord(record));
};

const parseJsonRecord = (record: string): unknown => {
  try {
    return JSON.parse(record);
  } catch {
    throw new Error("Invalid Devvit state JSON record.");
  }
};

const discardTransaction = async (
  transaction: DevvitStateRedisTransaction,
): Promise<void> => {
  try {
    await transaction.discard();
  } catch {
    // If EXEC already closed the transaction, there is nothing left to discard.
  }
};

const getDevvitStateStorageKeys = (
  stateKey: string,
): DevvitStateStorageKeys => {
  return {
    version: `devvit-state:${stateKey}:version`,
    snapshot: `devvit-state:${stateKey}:snapshot`,
    updates: `devvit-state:${stateKey}:updates`,
  };
};
