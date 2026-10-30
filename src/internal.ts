/**
 * 内部导出面：只给本仓库的测试与排障用（`node -e "import('./lib/internal.js')"`）。
 *
 * 不从这里导出到 `index.ts`：插件对宿主的公开面只有 `name/inject/apply`，
 * 多导出一个函数就多一份需要长期兼容的契约。
 */
export * as ipc from './ipc.js';
export * as errors from './errors.js';
export * as config from './config.js';
export * as paths from './paths.js';
export * as state from './state.js';
export * as locate from './core/locate.js';
export * as release from './core/release.js';
export * as handshake from './core/handshake.js';
export * as channel from './core/channel.js';
export * as exec from './core/exec.js';
export * as run from './core/run.js';
export * as core from './host/core.js';
export * as credentials from './host/credentials.js';
export * as quickfill from './host/quickfill.js';
export * as preflight from './host/preflight.js';
export * as proxy from './host/proxy.js';
export * as runner from './host/runner.js';
export * as schedule from './host/schedule.js';
export * as routes from './host/routes.js';
export * as importCli from './host/import-cli.js';
export * as tools from './tools.js';
