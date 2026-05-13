import {
  realtime as defaultRealtime,
  redis as defaultRedis,
} from "@devvit/web/server";
import type { ZodType } from "zod";
import {
  applyDevvitStatePatches,
  asDevvitStateJsonValue,
  cloneDevvitStateJson,
  createDevvitStatePatches,
  createDevvitStateSnapshotSchema,
  createDevvitStateValueSchema,
  devvitStateUpdateSchema,
  type DevvitStateUpdate,
  type DevvitStateUpdatesSinceResult,
  type DevvitStatePatch,
  type DevvitStateSnapshot,
} from "../shared/index.js";
import { getDevvitStateRealtimeChannel } from "../shared/channel.js";

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
  send(update: DevvitStateUpdate): Promise<void>;
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
  /** Initial value used when no snapshot exists yet. */
  defaultValue?: () => State;
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
  /** Reads the current authoritative snapshot. */
  getCurrent(): Promise<DevvitStateSnapshot<State>>;
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
 * Creates an initialized server-side manager for Zod-typed atomic Devvit state.
 */
export const createDevvitState = async <State>({
  key,
  schema,
  defaultValue,
  maxUpdates = defaultMaxUpdates,
  maxUpdateFetchLimit = defaultMaxUpdateFetchLimit,
  now = Date.now,
  redis = defaultRedis,
  realtime: customRealtime,
}: CreateDevvitStateOptions<State>): Promise<DevvitState<State>> => {
  if (!Number.isSafeInteger(maxUpdates) || maxUpdates < 1) {
    throw new Error("maxUpdates must be a positive safe integer.");
  }

  if (!Number.isSafeInteger(maxUpdateFetchLimit) || maxUpdateFetchLimit < 1) {
    throw new Error("maxUpdateFetchLimit must be a positive safe integer.");
  }

  const storageKeys = getDevvitStateStorageKeys(key);
  const channel = getDevvitStateRealtimeChannel(key);
  const realtimeClient =
    customRealtime ??
    ({
      send: async (update: DevvitStateUpdate) => {
        await defaultRealtime.send(channel, update);
      },
    } satisfies DevvitStateRealtime);
  const stateSchema = createDevvitStateValueSchema(schema);
  const snapshotSchema = createDevvitStateSnapshotSchema(schema);

  const initializeState = async (): Promise<DevvitStateSnapshot<State>> => {
    return commitWithRetry(
      redis,
      // Watch the snapshot key so two first-time initializers do not both
      // create different version-zero records.
      [storageKeys.snapshot],
      async (transaction) => {
        const existingSnapshot = await readStoredSnapshot({
          redis,
          snapshotKey: storageKeys.snapshot,
          snapshotSchema,
        });

        if (existingSnapshot) {
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

        return results.length > 0 ? snapshot : RETRY;
      },
      `Failed to initialize state ${key}.`,
    );
  };

  await initializeState();

  const getCurrent = async (): Promise<DevvitStateSnapshot<State>> => {
    const snapshot = await readStoredSnapshot({
      redis,
      snapshotKey: storageKeys.snapshot,
      snapshotSchema,
    });

    if (!snapshot) {
      throw new Error(`State ${key} snapshot is missing.`);
    }

    return snapshot;
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
      redis,
      realtime: realtimeClient,
      storageKeys,
      snapshotSchema,
      maxUpdates,
      now,
      produceMutation: (snapshot) => {
        const draft = structuredClone(snapshot.state);

        producer(draft);

        const nextState = stateSchema.parse(draft);
        const patches = createDevvitStatePatches(
          asDevvitStateJsonValue(snapshot.state),
          asDevvitStateJsonValue(nextState),
        );

        return { patches, nextState };
      },
    });
  };

  const patch = async (
    patches: readonly DevvitStatePatch[],
  ): Promise<DevvitStateUpdate | null> => {
    return commitMutation({
      key,
      redis,
      realtime: realtimeClient,
      storageKeys,
      snapshotSchema,
      maxUpdates,
      now,
      produceMutation: (snapshot) => {
        const previousJsonState = asDevvitStateJsonValue(snapshot.state);
        const nextState = stateSchema.parse(
          applyDevvitStatePatches(previousJsonState, patches),
        );
        const computedPatches = createDevvitStatePatches(
          previousJsonState,
          asDevvitStateJsonValue(nextState),
        );

        return { patches: computedPatches, nextState };
      },
    });
  };

  return {
    key,
    getCurrent,
    getUpdatesSince,
    mutate,
    patch,
  };
};

type DevvitStateMutationResult<State> = {
  patches: readonly DevvitStatePatch[];
  nextState: State;
};

const commitMutation = async <State>({
  key,
  redis,
  realtime,
  storageKeys,
  snapshotSchema,
  maxUpdates,
  now,
  produceMutation,
}: {
  key: string;
  redis: DevvitStateRedis;
  realtime: DevvitStateRealtime;
  storageKeys: DevvitStateStorageKeys;
  snapshotSchema: ZodType<DevvitStateSnapshot<State>>;
  maxUpdates: number;
  now: () => number;
  // The producer is evaluated after WATCH so transaction conflicts rerun the
  // mutation against the newest committed snapshot.
  produceMutation: (
    snapshot: DevvitStateSnapshot<State>,
  ) => DevvitStateMutationResult<State>;
}): Promise<DevvitStateUpdate | null> => {
  return commitWithRetry(
    redis,
    [storageKeys.version],
    async (transaction) => {
      const snapshot = await readStoredSnapshot({
        redis,
        snapshotKey: storageKeys.snapshot,
        snapshotSchema,
      });

      if (!snapshot) {
        throw new Error(`State ${key} snapshot is missing.`);
      }

      const currentVersion = await readCurrentVersion(
        redis,
        storageKeys.version,
      );

      if (currentVersion !== snapshot.version) {
        throw new Error(`State ${key} has inconsistent Redis version records.`);
      }

      const { patches: rawPatches, nextState } = produceMutation(snapshot);

      if (rawPatches.length === 0) {
        return null;
      }

      const patches = rawPatches.map(cloneDevvitStatePatch);
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

      if (results[0] === nextVersion) {
        // Realtime is a fast path only. If broadcast fails, clients can still
        // recover from the committed update log.
        await broadcastUpdate(realtime, update);
        return update;
      }

      return RETRY;
    },
    `Failed to commit state ${key}.`,
  );
};

const RETRY: unique symbol = Symbol("devvit-state.retry");
type RetrySignal = typeof RETRY;

const commitWithRetry = async <T>(
  redis: DevvitStateRedis,
  watchKeys: readonly string[],
  attempt: (
    transaction: DevvitStateRedisTransaction,
  ) => Promise<T | RetrySignal>,
  exhaustedMessage: string,
): Promise<T> => {
  for (let i = 0; i < maxCommitAttempts; i += 1) {
    const transaction = await redis.watch(...watchKeys);

    try {
      const outcome = await attempt(transaction);

      if (outcome !== RETRY) {
        return outcome;
      }
    } finally {
      // Idempotent: a no-op if exec() already closed the transaction.
      await discardTransaction(transaction);
    }
  }

  throw new Error(exhaustedMessage);
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
  update: DevvitStateUpdate,
): Promise<void> => {
  try {
    await realtimeClient.send(update);
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
