export interface PublishCommandResult {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
  signal?: string | null
}
export interface NpmLifecycleReadOptions {
  token?: string
  timeoutMs?: number
  fetch?: (url: string, options: RequestInit) => Promise<Response>
}
/** null denotes the official endpoint's ambiguous HTTP 404; other HTTP failures throw. */
export function readNpmPackageLifecycle(packageName: string, version: string, options?: NpmLifecycleReadOptions): Promise<string | null>
export interface PublishVerifiedOptions {
  readLifecycle?: (packageName: string, version: string, options: { timeoutMs: number }) => Promise<string | null>
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => number
  waitTimeoutMs?: number
  pollIntervalMs?: number
  lifecycleTimeoutMs?: number
}
export function publishVerifiedPackage(
  manifestFile: string,
  packageDirectory: string,
  registry: string,
  execute?: (command: string, args: string[], options: {
    encoding: string; timeout: number; env: NodeJS.ProcessEnv
  }) => PublishCommandResult,
  options?: PublishVerifiedOptions,
): Promise<void>
