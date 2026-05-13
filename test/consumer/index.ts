import { z } from "zod";
import { createDevvitState } from "devvit-state/server";
import { createDevvitStateClient } from "devvit-state/client";
import {
  applyDevvitStatePatches,
  type DevvitStateUpdate,
} from "devvit-state/shared";

const schema = z.object({
  count: z.number(),
});
const key = "consumer:test";
const serverState = await createDevvitState({
  key,
  schema,
  defaultValue: () => ({
    count: 0,
  }),
});
const clientState = createDevvitStateClient({
  key,
  schema,
  fetchSnapshot: async () => ({
    version: 0,
    state: {
      count: 0,
    },
    updatedAtMs: 0,
  }),
  fetchUpdatesSince: async () => ({
    currentVersion: 0,
    updates: [],
    hasMore: false,
  }),
});
const update: DevvitStateUpdate = {
  stateKey: key,
  version: 1,
  patches: [
    {
      op: "replace",
      path: "/count",
      value: 1,
    },
  ],
  createdAtMs: 1,
};

void serverState;
void clientState;
void applyDevvitStatePatches(
  {
    count: 0,
  },
  update.patches,
);
