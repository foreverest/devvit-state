import { z } from "zod";
import { createDevvitState } from "devvit-state/server";
import { createDevvitStateClient } from "devvit-state/client";
import {
  applyDevvitStatePatches,
  getDevvitStateRealtimeChannel,
  type DevvitStateUpdate,
} from "devvit-state/shared";

const schema = z.object({
  count: z.number(),
});
const key = "consumer:test";
const channel = getDevvitStateRealtimeChannel(key);
const serverState = createDevvitState({
  key,
  schema,
  defaultValue: () => ({
    count: 0,
  }),
});
const clientState = createDevvitStateClient({
  key,
  schema,
  channel,
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
  updateId: `${key}:1`,
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
