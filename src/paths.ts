/**
 * 本插件的落盘位置。
 *
 * 与 DSH 的约定一致：决定性状态放 `$DSH_HOME/<plugin>/`，可丢缓存另放
 * `$DSH_HOME/cache/<plugin>/`。这里只用到状态目录（设置、运行记录、日志）。
 * 每次读取都走 env，方便测试注入合成的 DSH_HOME，不去碰真实 `~/.dsh`。
 */
import os from 'node:os';
import path from 'node:path';

export const PLUGIN_DIR_NAME = 'github-trending';

export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.HOME?.trim();
  return raw !== undefined && raw !== '' ? path.resolve(raw) : os.homedir();
}

export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DSH_HOME?.trim();
  return raw !== undefined && raw !== '' ? path.resolve(raw) : path.join(homeDir(env), '.dsh');
}

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.TRENDING_DIGEST_HOME?.trim();
  if (raw !== undefined && raw !== '') return path.resolve(raw);
  return path.join(dshHome(env), PLUGIN_DIR_NAME);
}

export function runsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dataDir(env), 'runs');
}

export const SETTINGS_FILE = 'settings.json';
export const STATE_FILE = 'state.json';
export const HISTORY_FILE = 'history.json';
