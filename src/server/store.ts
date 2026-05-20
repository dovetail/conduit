/**
 * Env-var-backed config for the server. Secrets are injected by the platform
 * (External Secrets Operator → AWS Secrets Manager → K8s Secret → env vars).
 *
 * In local development, set these in your shell or `docker-compose.yml`.
 */

export function getGithubPat(): string | undefined {
  return process.env.GITHUB_PAT || undefined
}

export function getSlackSigningSecret(): string | undefined {
  return process.env.SLACK_SIGNING_SECRET || undefined
}

export function getAnthropicApiKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY || undefined
}
