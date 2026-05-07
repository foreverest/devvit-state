/**
 * Creates the default Devvit Realtime channel for a state key.
 *
 * The channel is deterministic and only contains characters that are safe
 * for Devvit Realtime channel names. Alphanumerics pass through verbatim;
 * any other byte is encoded as `_XX` (lowercase hex), with `_` itself
 * escaped to `_5f` so the encoding is unambiguous.
 */
export const getDevvitStateRealtimeChannel = (stateKey: string): string => {
  const encoded = Array.from(new TextEncoder().encode(stateKey))
    .map((byte) => {
      const isAlphanumeric =
        (byte >= 0x30 && byte <= 0x39) || // 0-9
        (byte >= 0x41 && byte <= 0x5a) || // A-Z
        (byte >= 0x61 && byte <= 0x7a); // a-z

      return isAlphanumeric
        ? String.fromCharCode(byte)
        : `_${byte.toString(16).padStart(2, "0")}`;
    })
    .join("");

  return `devvit_state_${encoded}`;
};
