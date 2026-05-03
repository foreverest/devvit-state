import type {
  DevvitStateJsonObject,
  DevvitStateJsonValue,
  DevvitStatePatch,
} from "./schemas";

/**
 * Clones a JSON-compatible state value.
 */
export const cloneDevvitStateJson = <Value extends DevvitStateJsonValue>(
  value: Value,
): Value => {
  return structuredClone(value);
};

/**
 * Creates JSON Patch-style operations that transform one state value into another.
 */
export const createDevvitStatePatches = (
  previousValue: DevvitStateJsonValue,
  nextValue: DevvitStateJsonValue,
): DevvitStatePatch[] => {
  return diffDevvitStateJson(previousValue, nextValue, "");
};

/**
 * Applies JSON Patch-style operations immutably and returns the next state value.
 */
export const applyDevvitStatePatches = (
  value: DevvitStateJsonValue,
  patches: readonly DevvitStatePatch[],
): DevvitStateJsonValue => {
  return patches.reduce(applyDevvitStatePatch, value);
};

const diffDevvitStateJson = (
  previousValue: DevvitStateJsonValue,
  nextValue: DevvitStateJsonValue,
  path: string,
): DevvitStatePatch[] => {
  if (isDeepEqual(previousValue, nextValue)) {
    return [];
  }

  if (Array.isArray(previousValue) && Array.isArray(nextValue)) {
    return diffDevvitStateArrays(previousValue, nextValue, path);
  }

  if (isJsonObject(previousValue) && isJsonObject(nextValue)) {
    return diffDevvitStateObjects(previousValue, nextValue, path);
  }

  return [
    {
      op: "replace",
      path,
      value: cloneDevvitStateJson(nextValue),
    },
  ];
};

const diffDevvitStateArrays = (
  previousValue: DevvitStateJsonValue[],
  nextValue: DevvitStateJsonValue[],
  path: string,
): DevvitStatePatch[] => {
  const shortestLength = Math.min(previousValue.length, nextValue.length);

  for (let index = 0; index < shortestLength; index += 1) {
    if (!isDeepEqual(previousValue[index] ?? null, nextValue[index] ?? null)) {
      if (previousValue.length === nextValue.length) {
        return diffArrayItems(previousValue, nextValue, path);
      }

      // Array inserts/reorders shift later indexes. Replacing the array keeps
      // generated patches correct instead of pretending a reorder is a set of
      // independent item edits.
      return [
        {
          op: "replace",
          path,
          value: cloneDevvitStateJson(nextValue),
        },
      ];
    }
  }

  if (nextValue.length > previousValue.length) {
    return nextValue.slice(previousValue.length).map((value) => ({
      op: "add",
      path: joinJsonPointer(path, "-"),
      value: cloneDevvitStateJson(value),
    }));
  }

  return previousValue.slice(nextValue.length).map((_, offset) => ({
    op: "remove",
    path: joinJsonPointer(path, String(previousValue.length - offset - 1)),
  }));
};

const diffArrayItems = (
  previousValue: DevvitStateJsonValue[],
  nextValue: DevvitStateJsonValue[],
  path: string,
): DevvitStatePatch[] => {
  const patches: DevvitStatePatch[] = [];

  for (let index = 0; index < previousValue.length; index += 1) {
    const previousItem = previousValue[index];
    const nextItem = nextValue[index];

    if (previousItem !== undefined && nextItem !== undefined) {
      patches.push(
        ...diffDevvitStateJson(
          previousItem,
          nextItem,
          joinJsonPointer(path, String(index)),
        ),
      );
    }
  }

  return patches;
};

const diffDevvitStateObjects = (
  previousValue: DevvitStateJsonObject,
  nextValue: DevvitStateJsonObject,
  path: string,
): DevvitStatePatch[] => {
  const patches: DevvitStatePatch[] = [];
  const previousKeys = Object.keys(previousValue);
  const nextKeys = Object.keys(nextValue);
  const nextKeySet = new Set(nextKeys);
  const previousKeySet = new Set(previousKeys);

  for (const key of previousKeys) {
    if (!nextKeySet.has(key)) {
      patches.push({
        op: "remove",
        path: joinJsonPointer(path, key),
      });
    }
  }

  for (const key of nextKeys) {
    const nextItem = nextValue[key];

    if (nextItem === undefined) {
      continue;
    }

    if (!previousKeySet.has(key)) {
      patches.push({
        op: "add",
        path: joinJsonPointer(path, key),
        value: cloneDevvitStateJson(nextItem),
      });
      continue;
    }

    const previousItem = previousValue[key];

    if (previousItem !== undefined) {
      patches.push(
        ...diffDevvitStateJson(
          previousItem,
          nextItem,
          joinJsonPointer(path, key),
        ),
      );
    }
  }

  return patches;
};

const applyDevvitStatePatch = (
  value: DevvitStateJsonValue,
  patch: DevvitStatePatch,
): DevvitStateJsonValue => {
  const pathSegments = parseJsonPointer(patch.path);

  return applyPatchAtPath(value, pathSegments, patch);
};

const applyPatchAtPath = (
  value: DevvitStateJsonValue,
  pathSegments: readonly string[],
  patch: DevvitStatePatch,
): DevvitStateJsonValue => {
  const segment = pathSegments[0];

  if (segment === undefined) {
    if (patch.op === "remove") {
      throw new Error("Cannot remove the root state value.");
    }

    return cloneDevvitStateJson(patch.value);
  }

  const remainingPathSegments = pathSegments.slice(1);

  if (Array.isArray(value)) {
    return applyArrayPatchAtPath(value, segment, remainingPathSegments, patch);
  }

  if (isJsonObject(value)) {
    return applyObjectPatchAtPath(value, segment, remainingPathSegments, patch);
  }

  throw new Error(`Cannot apply patch at ${patch.path}.`);
};

const applyArrayPatchAtPath = (
  value: DevvitStateJsonValue[],
  segment: string,
  remainingPathSegments: readonly string[],
  patch: DevvitStatePatch,
): DevvitStateJsonValue[] => {
  if (remainingPathSegments.length === 0) {
    return applyArrayPatchLeaf(value, segment, patch);
  }

  const index = parseExistingArrayIndex(value, segment, patch.path);
  const currentValue = value[index];

  if (currentValue === undefined) {
    throw new Error(`Cannot apply patch at ${patch.path}.`);
  }

  const nextValue = value.slice();

  nextValue[index] = applyPatchAtPath(
    currentValue,
    remainingPathSegments,
    patch,
  );

  return nextValue;
};

const applyArrayPatchLeaf = (
  value: DevvitStateJsonValue[],
  segment: string,
  patch: DevvitStatePatch,
): DevvitStateJsonValue[] => {
  if (patch.op === "add") {
    const index =
      segment === "-" ? value.length : parseArrayIndex(segment, patch.path);

    if (index < 0 || index > value.length) {
      throw new Error(`Array add index out of bounds at ${patch.path}.`);
    }

    return [
      ...value.slice(0, index),
      cloneDevvitStateJson(patch.value),
      ...value.slice(index),
    ];
  }

  const index = parseExistingArrayIndex(value, segment, patch.path);

  if (patch.op === "remove") {
    return [...value.slice(0, index), ...value.slice(index + 1)];
  }

  return [
    ...value.slice(0, index),
    cloneDevvitStateJson(patch.value),
    ...value.slice(index + 1),
  ];
};

const applyObjectPatchAtPath = (
  value: DevvitStateJsonObject,
  segment: string,
  remainingPathSegments: readonly string[],
  patch: DevvitStatePatch,
): DevvitStateJsonObject => {
  if (remainingPathSegments.length === 0) {
    return applyObjectPatchLeaf(value, segment, patch);
  }

  if (!Object.hasOwn(value, segment)) {
    throw new Error(`Cannot apply patch at ${patch.path}.`);
  }

  const currentValue = value[segment];

  if (currentValue === undefined) {
    throw new Error(`Cannot apply patch at ${patch.path}.`);
  }

  return {
    ...value,
    [segment]: applyPatchAtPath(currentValue, remainingPathSegments, patch),
  };
};

const applyObjectPatchLeaf = (
  value: DevvitStateJsonObject,
  segment: string,
  patch: DevvitStatePatch,
): DevvitStateJsonObject => {
  if (patch.op === "remove") {
    if (!Object.hasOwn(value, segment)) {
      throw new Error(`Cannot remove missing object field at ${patch.path}.`);
    }

    const nextValue: DevvitStateJsonObject = {};

    for (const [key, item] of Object.entries(value)) {
      if (key !== segment) {
        nextValue[key] = item;
      }
    }

    return nextValue;
  }

  if (patch.op === "replace" && !Object.hasOwn(value, segment)) {
    throw new Error(`Cannot replace missing object field at ${patch.path}.`);
  }

  return {
    ...value,
    [segment]: cloneDevvitStateJson(patch.value),
  };
};

const parseJsonPointer = (path: string): string[] => {
  if (path === "") {
    return [];
  }

  if (!path.startsWith("/")) {
    throw new Error(`Invalid JSON Pointer path: ${path}.`);
  }

  return path.slice(1).split("/").map(decodeJsonPointerSegment);
};

const joinJsonPointer = (basePath: string, segment: string): string => {
  return `${basePath}/${encodeJsonPointerSegment(segment)}`;
};

const encodeJsonPointerSegment = (segment: string): string => {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
};

const decodeJsonPointerSegment = (segment: string): string => {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
};

const parseExistingArrayIndex = (
  value: readonly DevvitStateJsonValue[],
  segment: string,
  path: string,
): number => {
  const index = parseArrayIndex(segment, path);

  if (index < 0 || index >= value.length) {
    throw new Error(`Array index out of bounds at ${path}.`);
  }

  return index;
};

const parseArrayIndex = (segment: string, path: string): number => {
  if (!/^(0|[1-9]\d*)$/.test(segment)) {
    throw new Error(`Invalid array index at ${path}.`);
  }

  return Number(segment);
};

const isJsonObject = (
  value: DevvitStateJsonValue,
): value is DevvitStateJsonObject => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const isDeepEqual = (
  left: DevvitStateJsonValue,
  right: DevvitStateJsonValue,
): boolean => {
  if (Object.is(left, right)) {
    return true;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    return areArraysDeepEqual(left, right);
  }

  if (isJsonObject(left) && isJsonObject(right)) {
    return areObjectsDeepEqual(left, right);
  }

  return false;
};

const areArraysDeepEqual = (
  left: readonly DevvitStateJsonValue[],
  right: readonly DevvitStateJsonValue[],
): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((item, index) => {
    const rightItem = right[index];

    return rightItem !== undefined && isDeepEqual(item, rightItem);
  });
};

const areObjectsDeepEqual = (
  left: DevvitStateJsonObject,
  right: DevvitStateJsonObject,
): boolean => {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every((key) => {
    const leftValue = left[key];
    const rightValue = right[key];

    return (
      leftValue !== undefined &&
      rightValue !== undefined &&
      isDeepEqual(leftValue, rightValue)
    );
  });
};
