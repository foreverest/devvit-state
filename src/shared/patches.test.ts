import { describe, expect, test } from "vitest";
import {
  applyDevvitStatePatches,
  createDevvitStatePatches,
  type DevvitStateJsonValue,
} from "./index";

describe("Devvit state patches", () => {
  test("generates and applies object and array patches immutably", () => {
    const previousState = {
      profile: {
        name: "Ada",
        enabled: true,
      },
      numbers: [1, 2, 3],
    };
    const nextState = {
      profile: {
        name: "Grace",
      },
      numbers: [1, 2, 3, 42],
    };

    const patches = createDevvitStatePatches(previousState, nextState);
    const appliedState = applyDevvitStatePatches(previousState, patches);

    expect(patches).toEqual([
      {
        op: "remove",
        path: "/profile/enabled",
      },
      {
        op: "replace",
        path: "/profile/name",
        value: "Grace",
      },
      {
        op: "add",
        path: "/numbers/-",
        value: 42,
      },
    ]);
    expect(appliedState).toEqual(nextState);
    expect(previousState).toEqual({
      profile: {
        name: "Ada",
        enabled: true,
      },
      numbers: [1, 2, 3],
    });
  });

  test("escapes JSON Pointer path segments", () => {
    const previousState = {
      "a/b": {
        "~key": "old",
      },
    };
    const nextState = {
      "a/b": {
        "~key": "new",
      },
    };

    const patches = createDevvitStatePatches(previousState, nextState);

    expect(patches).toEqual([
      {
        op: "replace",
        path: "/a~1b/~0key",
        value: "new",
      },
    ]);
    expect(applyDevvitStatePatches(previousState, patches)).toEqual(nextState);
  });

  test("falls back to replacing complex array edits", () => {
    const previousState: DevvitStateJsonValue = {
      numbers: [1, 2, 3],
    };
    const nextState: DevvitStateJsonValue = {
      numbers: [1, 9, 2, 3],
    };

    const patches = createDevvitStatePatches(previousState, nextState);

    expect(patches).toEqual([
      {
        op: "replace",
        path: "/numbers",
        value: [1, 9, 2, 3],
      },
    ]);
    expect(applyDevvitStatePatches(previousState, patches)).toEqual(nextState);
  });

  test("rejects invalid patch paths", () => {
    expect(() =>
      applyDevvitStatePatches(
        {
          numbers: [1],
        },
        [
          {
            op: "remove",
            path: "/numbers/4",
          },
        ],
      ),
    ).toThrow("Array index out of bounds");
  });
});
