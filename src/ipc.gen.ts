/**
 * 由 scripts/gen-ipc-types.mjs 从 contract/schema/ipc.v1.json 生成，**不要手改**。
 * 上游：https://github.com/morehao/trendradar.git@5cf0ad26c5748cf2bc9a1cc4ce66a09411d590f7
 * aggregate：4717074d26d1a6d85c1885bd052d411f81c20b39467cb81c398f565bbe34dcde
 * 重新生成：npm run gen:ipc
 */
export type ErrorCode = "INTERNAL" | "CONFIG_INVALID" | "PAYLOAD_TOO_LARGE" | "FETCH_FAILED" | "FETCH_RATE_LIMITED" | "PARSE_FAILED" | "MODEL_UNAUTHORIZED" | "MODEL_RATE_LIMITED" | "MODEL_TIMEOUT" | "MODEL_FAILED" | "MODEL_BAD_OUTPUT" | "GIT_NOT_INSTALLED" | "REPO_NOT_GIT" | "REPO_DIRTY" | "GIT_OPERATION_FAILED" | "PR_FAILED" | "NOT_MERGEABLE";

export interface ErrorInfo {
  code: ErrorCode
  message: string
  retriable: boolean
  details?: Record<string, unknown>
  [key: string]: unknown
}

export interface FileArtifact {
  path: string
  bytes: number
  sha256: string
  [key: string]: unknown
}

export interface RunRequest {
  ipcSchema: 1
  command: "run" | "serve" | "config" | "version"
  configPath?: string
  date?: string
  dryRun?: boolean
  outputDir?: string
}

export interface RunResult {
  ipcSchema: 1
  ok: boolean
  command: "run" | "serve" | "config" | "version"
  startedAt: string
  finishedAt: string
  skipped: boolean
  files: FileArtifact[]
  error?: ErrorInfo
  warnings?: string[]
  [key: string]: unknown
}

export interface StateRun {
  date: string
  contentHash: string
  outputDir?: string
  runAt: string
  [key: string]: unknown
}

export interface State {
  ipcSchema: 1
  lastRun?: StateRun
  [key: string]: unknown
}

export const IPC_SCHEMA_VERSION = 1 as const;
