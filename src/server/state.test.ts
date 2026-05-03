import { afterEach, describe, expect, test, vi } from "vitest";
import { redis } from "@devvit/web/server";
import { createDevvitTest } from "@devvit/test/server/vitest";
import { z } from "zod";
import { createDevvitState, getDevvitStateRealtimeChannel } from "./index";

const devvitTest = createDevvitTest({
  subredditName: "devvit_state_test",
});
const testStateSchema = z.object({
  hello: z.string().min(1),
  numbers: z.array(z.number()),
});

const createState = (key: string, maxUpdates = 1_000) => {
  return createDevvitState({
    key,
    schema: testStateSchema,
    defaultValue: () => ({
      hello: "world",
      numbers: [1, 2, 3],
    }),
    maxUpdates,
    now: () => 123_000,
  });
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Devvit state server", () => {
  devvitTest(
    "initializes missing state and preserves existing state",
    async () => {
      const state = createState("server:init");

      await expect(state.initialize()).resolves.toEqual({
        version: 0,
        state: {
          hello: "world",
          numbers: [1, 2, 3],
        },
        updatedAtMs: 123_000,
      });

      await state.mutate((draft) => {
        draft.numbers.push(42);
      });

      await expect(state.initialize()).resolves.toEqual({
        version: 1,
        state: {
          hello: "world",
          numbers: [1, 2, 3, 42],
        },
        updatedAtMs: 123_000,
      });
    },
  );

  devvitTest(
    "runs initialization side writes only for missing state",
    async () => {
      const state = createState("server:init-side-write");
      const sideKey = "server:init-side-write:side";

      await state.initialize({
        writeTransaction: async (transaction) => {
          await transaction.set(sideKey, "created");
        },
      });
      await state.initialize({
        writeTransaction: async (transaction) => {
          await transaction.set(sideKey, "overwritten");
        },
      });

      await expect(redis.get(sideKey)).resolves.toBe("created");
    },
  );

  devvitTest(
    "rejects invalid default values and invalid next states",
    async () => {
      const invalidDefaultState = createDevvitState({
        key: "server:invalid-default",
        schema: testStateSchema,
      });
      const state = createState("server:invalid-mutation");

      await expect(invalidDefaultState.initialize()).rejects.toThrow();

      await state.initialize();

      await expect(
        state.mutate((draft) => {
          draft.hello = "";
        }),
      ).rejects.toThrow();
    },
  );

  devvitTest(
    "commits snapshot, version, update log, and broadcast",
    async ({ mocks }) => {
      const state = createState("server:commit");

      await state.initialize();

      const update = await state.mutate((draft) => {
        draft.numbers.push(42);
      });

      await expect(state.getCurrent()).resolves.toEqual({
        version: 1,
        state: {
          hello: "world",
          numbers: [1, 2, 3, 42],
        },
        updatedAtMs: 123_000,
      });
      await expect(
        state.getUpdatesSince({
          sinceVersion: 0,
        }),
      ).resolves.toEqual({
        currentVersion: 1,
        updates: [update],
        hasMore: false,
      });
      expect(update).toMatchObject({
        stateKey: "server:commit",
        updateId: "server:commit:1",
        version: 1,
        patches: [
          {
            op: "add",
            path: "/numbers/-",
            value: 42,
          },
        ],
        createdAtMs: 123_000,
      });
      expect(
        mocks.realtime.getSentMessagesForChannel(state.channel)[0]?.data?.msg,
      ).toEqual(update);
    },
  );

  devvitTest(
    "commits mutation side writes in the state transaction",
    async () => {
      const state = createState("server:side-write");
      const sideKey = "server:side-write:side";

      await state.initialize();

      await state.mutate(
        (draft) => {
          draft.numbers.push(42);
        },
        {
          writeTransaction: async (transaction) => {
            await transaction.set(sideKey, "committed");
          },
        },
      );

      await expect(redis.get(sideKey)).resolves.toBe("committed");
      await expect(state.getCurrent()).resolves.toMatchObject({
        version: 1,
        state: {
          numbers: [1, 2, 3, 42],
        },
      });
    },
  );

  devvitTest(
    "commits no-op mutation side writes without creating an update",
    async ({ mocks }) => {
      const state = createState("server:no-op-side-write");
      const sideKey = "server:no-op-side-write:side";

      await state.initialize();

      const update = await state.mutate(() => {}, {
        writeTransaction: async (transaction) => {
          await transaction.set(sideKey, "committed");
        },
      });

      expect(update).toBeNull();
      await expect(redis.get(sideKey)).resolves.toBe("committed");
      await expect(state.getCurrent()).resolves.toMatchObject({
        version: 0,
      });
      await expect(
        state.getUpdatesSince({
          sinceVersion: 0,
        }),
      ).resolves.toMatchObject({
        currentVersion: 0,
        updates: [],
      });
      expect(mocks.realtime.getSentMessagesForChannel(state.channel)).toEqual(
        [],
      );
    },
  );

  devvitTest("commits low-level patches after schema validation", async () => {
    const state = createState("server:patch");

    await state.initialize();
    await state.patch([
      {
        op: "replace",
        path: "/hello",
        value: "patched",
      },
      {
        op: "remove",
        path: "/numbers/2",
      },
    ]);

    await expect(state.getCurrent()).resolves.toMatchObject({
      version: 1,
      state: {
        hello: "patched",
        numbers: [1, 2],
      },
    });
  });

  devvitTest(
    "retries aborted transactions with contiguous versions",
    async () => {
      const state = createState("server:retry");
      const originalWatch = redis.watch.bind(redis);
      let execCount = 0;

      await state.initialize();

      vi.spyOn(redis, "watch").mockImplementation(async (...keys) => {
        const transaction = await originalWatch(...keys);
        const originalExec = transaction.exec.bind(transaction);

        vi.spyOn(transaction, "exec").mockImplementation(async () => {
          execCount += 1;

          if (execCount === 1) {
            await transaction.discard();
            return [];
          }

          return await originalExec();
        });

        return transaction;
      });

      const update = await state.mutate((draft) => {
        draft.numbers.push(42);
      });

      expect(execCount).toBe(2);
      expect(update?.version).toBe(1);
      await expect(state.getCurrent()).resolves.toMatchObject({
        version: 1,
      });
    },
  );

  devvitTest("retries side writes after aborted transactions", async () => {
    const state = createState("server:retry-side-write");
    const sideKey = "server:retry-side-write:side";
    const originalWatch = redis.watch.bind(redis);
    let execCount = 0;
    let sideWriteCount = 0;

    await state.initialize();

    vi.spyOn(redis, "watch").mockImplementation(async (...keys) => {
      const transaction = await originalWatch(...keys);
      const originalExec = transaction.exec.bind(transaction);

      vi.spyOn(transaction, "exec").mockImplementation(async () => {
        execCount += 1;

        if (execCount === 1) {
          await transaction.discard();
          return [];
        }

        return await originalExec();
      });

      return transaction;
    });

    await state.mutate(
      (draft) => {
        draft.numbers.push(42);
      },
      {
        writeTransaction: async (transaction) => {
          sideWriteCount += 1;
          await transaction.set(sideKey, String(sideWriteCount));
        },
      },
    );

    expect(execCount).toBe(2);
    expect(sideWriteCount).toBe(2);
    await expect(redis.get(sideKey)).resolves.toBe("2");
  });

  devvitTest("reads bounded updates in sorted order with hasMore", async () => {
    const state = createState("server:updates");

    await state.initialize();
    await state.mutate((draft) => {
      draft.numbers.push(4);
    });
    await state.mutate((draft) => {
      draft.numbers.push(5);
    });
    await state.mutate((draft) => {
      draft.numbers.push(6);
    });

    await expect(
      state.getUpdatesSince({
        sinceVersion: 1,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      currentVersion: 3,
      updates: [
        {
          version: 2,
        },
      ],
      hasMore: true,
    });

    await expect(
      state.getUpdatesSince({
        sinceVersion: 1,
      }),
    ).resolves.toMatchObject({
      currentVersion: 3,
      updates: [
        {
          version: 2,
        },
        {
          version: 3,
        },
      ],
      hasMore: false,
    });
  });

  test("derives stable realtime channels from arbitrary keys", () => {
    expect(getDevvitStateRealtimeChannel("my-state:t3_post")).toMatch(
      /^devvit_state_[0-9a-f]+$/,
    );
    expect(getDevvitStateRealtimeChannel("a-b")).not.toBe(
      getDevvitStateRealtimeChannel("a_b"),
    );
  });
});
