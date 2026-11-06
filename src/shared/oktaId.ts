const OPAQUE_OKTA_ID = /^00[ug][a-zA-Z0-9]{17}$/

export function isOpaqueOktaId(value: string): boolean {
  return OPAQUE_OKTA_ID.test(value)
}
