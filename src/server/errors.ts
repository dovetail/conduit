/**
 * An expected, client-facing error — access denied, not found, validation, and
 * other normal business-rule rejections. These are surfaced to the user (so the
 * UI can show a message) but are deliberately NOT sent to the error reporter:
 * they are not faults, and reporting them just creates Sentry noise.
 */
export class ClientError extends Error {
  readonly isClientError = true as const

  constructor(message: string) {
    super(message)
    this.name = 'ClientError'
  }
}

/**
 * Duck-typed check so it holds even across module/realm boundaries (a plain
 * `instanceof` can miss when the class is loaded via two module instances).
 */
export function isClientError(err: unknown): err is ClientError {
  return (
    err instanceof ClientError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { isClientError?: boolean }).isClientError === true)
  )
}
