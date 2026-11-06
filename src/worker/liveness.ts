/**
 * Control-plane liveness for a worker socket.
 *
 * Heartbeat writes only prove the kernel accepted bytes. A half-open socket
 * (load balancer idle timeout, a replaced server pod, a blackholed path)
 * keeps readyState OPEN and never emits `close`, so the worker stays silent
 * until the server lease expires and fails the run. A ping that is not ponged
 * means the peer is gone — drop the socket so the close handler reconnects
 * inside the lease, instead of after it.
 */

/** How long a ping may go unanswered before the socket is treated as dead. */
export const WORKER_PONG_TIMEOUT_MS = 10_000

export interface WorkerSocketLiveness {
  /** True after ping() until the matching pong (or a timeout). */
  pingOutstanding: boolean
}

export function createWorkerSocketLiveness(): WorkerSocketLiveness {
  return { pingOutstanding: false }
}

/**
 * Record that we are about to ping. If the previous ping is still
 * outstanding the peer never answered — the socket is dead.
 */
export function beginPing(state: WorkerSocketLiveness): 'send' | 'dead' {
  if (state.pingOutstanding) return 'dead'
  state.pingOutstanding = true
  return 'send'
}

export function notePong(state: WorkerSocketLiveness): void {
  state.pingOutstanding = false
}

/** The pong timer fired. Dead only if that ping is still unanswered. */
export function onPongTimeout(state: WorkerSocketLiveness): 'dead' | 'alive' {
  if (!state.pingOutstanding) return 'alive'
  return 'dead'
}
