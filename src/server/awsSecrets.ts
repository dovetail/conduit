/**
 * Loads runtime secrets from AWS Secrets Manager at startup and merges
 * them into process.env, before any other module reads from env vars.
 *
 * Activated when CONDUIT_SECRETS_ARN is set. Designed for the platform
 * deployment, which doesn't run External Secrets Operator — instead the
 * pod has an IAM role (via EKS Pod Identity) that allows reading the
 * application secret, and this module fetches it directly.
 *
 * Locally / in docker-compose, CONDUIT_SECRETS_ARN is unset and this
 * is a no-op.
 */
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'

export async function loadSecretsFromAwsSm(): Promise<void> {
  const arn = process.env.CONDUIT_SECRETS_ARN
  if (!arn) return

  const region = process.env.AWS_REGION ?? 'us-east-1'
  const client = new SecretsManagerClient({ region })

  console.log(`[secrets] Loading ${arn} from AWS Secrets Manager (${region})`)
  const result = await client.send(new GetSecretValueCommand({ SecretId: arn }))

  if (!result.SecretString) {
    throw new Error(`Secret ${arn} has no SecretString (binary secrets not supported)`)
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(result.SecretString) as Record<string, unknown>
  } catch (err) {
    throw new Error(`Secret ${arn} is not valid JSON: ${(err as Error).message}`)
  }

  let injected = 0
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') continue
    // Don't override values already set in env — lets you locally override
    // a single key without re-encoding the whole secret.
    if (process.env[key] !== undefined) continue
    process.env[key] = value
    injected++
  }
  console.log(`[secrets] Loaded ${injected} env var(s) from ${arn}`)
}
