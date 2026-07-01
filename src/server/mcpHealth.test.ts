// src/server/mcpHealth.test.ts
import { describe, it, expect } from 'vitest'
import { classifyUrlHealth } from './mcpHealth'

describe('classifyUrlHealth', () => {
  it('401 -> unauthorized', () => {
    const result = classifyUrlHealth(401, 'Unauthorized')
    expect(result.status).toBe('unauthorized')
    expect(result.message).toContain('401')
  })

  it('403 -> unauthorized', () => {
    const result = classifyUrlHealth(403, 'Forbidden')
    expect(result.status).toBe('unauthorized')
    expect(result.message).toContain('403')
  })

  it('200 -> healthy', () => {
    const result = classifyUrlHealth(200, 'OK')
    expect(result.status).toBe('healthy')
    expect(result.message).toContain('200')
  })

  it('500 -> healthy (reachable but erroring)', () => {
    const result = classifyUrlHealth(500, 'Internal Server Error')
    expect(result.status).toBe('healthy')
    expect(result.message).toContain('500')
  })
})
