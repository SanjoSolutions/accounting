import path from 'node:path'

export type DocumentStorageDriver = 'fs' | 's3' | 'gcs' | 'azblob'

export interface OpenDalConfig {
  driver: DocumentStorageDriver
  options: Record<string, string>
}

export function getAuthoritativeStorageRegion(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const region = env.DOCUMENT_STORAGE_REGION?.trim()
  if (!region) throw new Error('DOCUMENT_STORAGE_REGION is required for jurisdiction-bound compliance storage')
  return region
}

export function getOpenDalConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd: string = process.cwd(),
): OpenDalConfig {
  const driver = (env.DOCUMENT_STORAGE_DRIVER || 'fs') as DocumentStorageDriver
  if (!['fs', 's3', 'gcs', 'azblob'].includes(driver)) {
    throw new Error(`Unsupported DOCUMENT_STORAGE_DRIVER: ${ driver }`)
  }

  const options: Record<string, string> = {}
  addOption(options, 'root', env.DOCUMENT_STORAGE_ROOT)

  if (driver === 'fs') {
    // The local root is normalized after generic option overrides are applied.
  } else if (driver === 's3') {
    addOption(options, 'bucket', env.DOCUMENT_STORAGE_BUCKET)
    addOption(options, 'region', env.DOCUMENT_STORAGE_REGION)
    addOption(options, 'endpoint', env.DOCUMENT_STORAGE_ENDPOINT)
    addOption(options, 'access_key_id', env.DOCUMENT_STORAGE_ACCESS_KEY_ID)
    addOption(options, 'secret_access_key', env.DOCUMENT_STORAGE_SECRET_ACCESS_KEY)
    addOption(options, 'session_token', env.DOCUMENT_STORAGE_SESSION_TOKEN)
  } else if (driver === 'gcs') {
    addOption(options, 'bucket', env.DOCUMENT_STORAGE_BUCKET)
    addOption(options, 'endpoint', env.DOCUMENT_STORAGE_ENDPOINT)
    addOption(options, 'credential', env.DOCUMENT_STORAGE_CREDENTIAL)
    addOption(options, 'credential_path', env.DOCUMENT_STORAGE_CREDENTIAL_PATH)
  } else {
    addOption(options, 'container', env.DOCUMENT_STORAGE_CONTAINER)
    addOption(options, 'endpoint', env.DOCUMENT_STORAGE_ENDPOINT)
    addOption(options, 'account_name', env.DOCUMENT_STORAGE_ACCOUNT_NAME)
    addOption(options, 'account_key', env.DOCUMENT_STORAGE_ACCOUNT_KEY)
    addOption(options, 'sas_token', env.DOCUMENT_STORAGE_SAS_TOKEN)
  }

  Object.assign(options, parseAdditionalOptions(env.DOCUMENT_STORAGE_OPTIONS))
  if (driver === 'fs') options.root = path.resolve(cwd, options.root || 'storage')
  if (driver === 's3' || driver === 'gcs') requireOption(driver, options, 'bucket')
  if (driver === 'azblob') requireOption(driver, options, 'container')
  return { driver, options }
}

function addOption(options: Record<string, string>, key: string, value?: string): void {
  if (value) options[key] = value
}

function requireOption(
  driver: DocumentStorageDriver,
  options: Record<string, string>,
  key: string,
): void {
  if (!options[key]) {
    throw new Error(`DOCUMENT_STORAGE_${ key.toUpperCase() } is required for ${ driver } storage`)
  }
}

function parseAdditionalOptions(value?: string): Record<string, string> {
  if (!value) return {}

  const parsed: unknown = JSON.parse(value)
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('DOCUMENT_STORAGE_OPTIONS must be a JSON object')
  }

  return Object.fromEntries(
    Object.entries(parsed).map(([key, option]) => [key, String(option)]),
  )
}
