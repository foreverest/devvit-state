import { z, type ZodType } from "zod";

/**
 * Runtime schema for JSON-compatible values accepted by Devvit state.
 */
export const devvitStateJsonValueSchema = z.json();

/**
 * JSON-compatible value type used for state, patch values, and Realtime updates.
 */
export type DevvitStateJsonValue = z.infer<typeof devvitStateJsonValueSchema>;

/**
 * JSON object type used internally by patch helpers.
 */
export type DevvitStateJsonObject = {
  [key: string]: DevvitStateJsonValue;
};

/**
 * Runtime schema for JSON Patch-style operations emitted in state updates.
 */
export const devvitStatePatchSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add"),
    path: z.string(),
    value: devvitStateJsonValueSchema,
  }),
  z.object({
    op: z.literal("replace"),
    path: z.string(),
    value: devvitStateJsonValueSchema,
  }),
  z.object({
    op: z.literal("remove"),
    path: z.string(),
  }),
]);

/**
 * Runtime schema for a committed atomic state update.
 */
export const devvitStateUpdateSchema = z.object({
  stateKey: z.string(),
  updateId: z.string(),
  version: z.number().int().nonnegative(),
  patches: z.array(devvitStatePatchSchema),
  createdAtMs: z.number().finite(),
});

/**
 * Runtime schema for update replay responses.
 */
export const devvitStateUpdatesSinceResultSchema = z.object({
  currentVersion: z.number().int().nonnegative(),
  updates: z.array(devvitStateUpdateSchema),
  hasMore: z.boolean(),
});

/**
 * One JSON Patch-style operation in a committed state update.
 */
export type DevvitStatePatch = z.infer<typeof devvitStatePatchSchema>;

/**
 * One committed atomic mutation. Each update advances state by exactly one version.
 */
export type DevvitStateUpdate = z.infer<typeof devvitStateUpdateSchema>;

/**
 * Result returned by update replay APIs.
 */
export type DevvitStateUpdatesSinceResult = z.infer<
  typeof devvitStateUpdatesSinceResultSchema
>;

/**
 * A versioned point-in-time state value.
 */
export type DevvitStateSnapshot<State = DevvitStateJsonValue> = {
  /** Monotonically increasing state version. */
  version: number;
  /** Zod-validated state value at this version. */
  state: State;
  /** Server timestamp for when this snapshot was written. */
  updatedAtMs: number;
};

/**
 * Creates a runtime snapshot schema for a caller-provided state schema.
 */
export const createDevvitStateSnapshotSchema = <State>(
  stateSchema: ZodType<State>,
): ZodType<DevvitStateSnapshot<State>> => {
  return z.object({
    version: z.number().int().nonnegative(),
    state: createDevvitStateValueSchema(stateSchema),
    updatedAtMs: z.number().finite(),
  });
};

/**
 * Wraps a caller-provided schema with JSON compatibility validation.
 */
export const createDevvitStateValueSchema = <State>(
  stateSchema: ZodType<State>,
): ZodType<State> => {
  return stateSchema.refine(
    (value) => devvitStateJsonValueSchema.safeParse(value).success,
    {
      message: "State must be JSON-compatible.",
    },
  );
};
