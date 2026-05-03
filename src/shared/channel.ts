/**
 * Creates the default Devvit Realtime channel for a state key.
 *
 * The channel is deterministic and only contains characters that are safe for
 * Devvit Realtime channel names.
 */
export const getDevvitStateRealtimeChannel = (stateKey: string): string => {
  const encodedStateKey = Array.from(new TextEncoder().encode(stateKey))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return `devvit_state_${encodedStateKey}`;
};
