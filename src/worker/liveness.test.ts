import { describe, expect, it } from 'vitest'
import {
  beginPing,
  createWorkerSocketLiveness,
  notePong,
  onPongTimeout,
  WORKER_PONG_TIMEOUT_MS,
} from './liveness'
import { WORKER_LEASE_MS } from '../shared/workerControl'

describe('worker socket liveness', () => {
  it('treats an unanswered ping as a dead socket before the server lease expires', () => {
    expect(WORKER_PONG_TIMEOUT_MS).toBeLessThan(WORKER_LEASE_MS)
    const state = createWorkerSocketLiveness()
    expect(beginPing(state)).toBe('send')
    expect(state.pingOutstanding).toBe(true)
    expect(onPongTimeout(state)).toBe('dead')
    expect(beginPing(state)).toBe('dead')
  })

  it('clears the outstanding ping when a pong arrives so the next beat is healthy', () => {
    const state = createWorkerSocketLiveness()
    expect(beginPing(state)).toBe('send')
    notePong(state)
    expect(state.pingOutstanding).toBe(false)
    expect(onPongTimeout(state)).toBe('alive')
    expect(beginPing(state)).toBe('send')
  })
})
