import { useSyncExternalStore } from "react"
import type { EphemeralState, EphemeralStream } from "../ephemeral.js"

/** Read a client.stream handle with frame-coalesced updates. Its owner opens and disposes it. */
export function useEphemeralStream<T, C>(stream: EphemeralStream<T, C>): EphemeralState<T, C> {
  return useSyncExternalStore(stream.subscribe, stream.getState, stream.getState)
}
