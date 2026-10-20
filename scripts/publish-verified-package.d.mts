export interface PublishCommandResult {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
  signal?: string | null
}
export function publishVerifiedPackage(
  manifestFile: string,
  packageDirectory: string,
  registry: string,
  execute?: (command: string, args: string[], options: {
    encoding: string; timeout: number; env: NodeJS.ProcessEnv
  }) => PublishCommandResult,
): void
