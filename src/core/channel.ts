/**
 * 把核心配置交给子进程的通道（密钥不落盘的关键）。
 *
 * 核心只接受 `--config <path>`，而配置里必须带 `model.apiKey`。为避免明文落盘：
 *
 * - POSIX：`mkfifo` 建一个命名管道，`--config` 指向它；核心 `os.ReadFile` 打开后，
 *   插件把 YAML 写进管道，读完即消失——文件系统里从未出现明文。
 * - Windows：没有 FIFO（也没有 `mkfifo`），退化为 0600 临时文件，**读完立刻删除**，
 *   并在运行结果里标注 `configChannel: 'tmpfile'`，让界面能如实提示。
 *
 * FIFO 的三个已知边界：
 *   1. 打开写端会阻塞到读端打开——所以必须在 spawn 之后再 publish；
 *   2. 核心若在打开前就失败退出，写端会一直阻塞 → 15 s 写超时兜底；
 *   3. 网络盘可能不支持 FIFO → mkfifo 失败即降级为临时文件，而不是让运行失败。
 */
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ChannelKind = 'fifo' | 'tmpfile';

export interface ConfigChannel {
  kind: ChannelKind;
  path: string;
  /** spawn 之后调用：把内容送进通道。 */
  publish(content: string): Promise<void>;
  /** 无论成功失败都要调用；幂等。 */
  dispose(): Promise<void>;
}

export const WRITE_TIMEOUT_MS = 15_000;

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'dsh-trending-'));
}

async function mkfifo(file: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('mkfifo', ['-m', '600', file], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`mkfifo 退出码 ${code ?? 'null'}：${stderr.trim()}`));
    });
  });
}

async function createFifoChannel(dir: string, writeTimeoutMs: number): Promise<ConfigChannel> {
  const file = path.join(dir, 'core.yml');
  await mkfifo(file);
  let disposed = false;
  return {
    kind: 'fifo',
    path: file,
    /**
     * 用 `O_NONBLOCK` 轮询打开写端：没有读端时 open 会返回 ENXIO 而不是**永久阻塞**。
     * 阻塞式 open 会把 libuv 的请求挂在事件循环上，超时后进程都退不掉——这正是
     * 「先轮询、再写」的理由。配置只有几 KB，写进管道缓冲区不会出现 EAGAIN。
     */
    async publish(content: string): Promise<void> {
      const deadline = Date.now() + writeTimeoutMs;
      let handle;
      for (;;) {
        try {
          handle = await open(file, constants.O_WRONLY | constants.O_NONBLOCK);
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENXIO' && code !== 'ENOENT') throw error;
          if (Date.now() >= deadline) {
            throw new Error(`FIFO 写超时（${writeTimeoutMs} ms）：核心未读取配置`);
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      try {
        await handle.writeFile(content, 'utf8');
      } finally {
        await handle.close();
      }
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await unlink(file).catch(() => undefined);
    },
  };
}

async function createTmpfileChannel(dir: string): Promise<ConfigChannel> {
  const file = path.join(dir, 'core.yml');
  let disposed = false;
  return {
    kind: 'tmpfile',
    path: file,
    async publish(content: string): Promise<void> {
      await writeFile(file, content, { mode: 0o600 });
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await unlink(file).catch(() => undefined);
    },
  };
}

/**
 * 建配置通道。`preferFifo=false` 或平台不是 POSIX 或 mkfifo 失败时走临时文件。
 */
export async function openConfigChannel(
  options: { preferFifo?: boolean; writeTimeoutMs?: number } = {},
): Promise<ConfigChannel> {
  const dir = tempDir();
  const preferFifo = options.preferFifo ?? process.platform !== 'win32';
  const writeTimeoutMs = options.writeTimeoutMs ?? WRITE_TIMEOUT_MS;
  if (preferFifo) {
    try {
      return await createFifoChannel(dir, writeTimeoutMs);
    } catch {
      // mkfifo 不可用（网络盘、受限容器）：退回临时文件
    }
  }
  return createTmpfileChannel(dir);
}

/** 清理通道所在目录（dispose 之后调用）。 */
export async function removeChannelDir(channel: ConfigChannel): Promise<void> {
  try {
    const info = await stat(channel.path);
    if (info.isFIFO()) return; // FIFO 的 dispose 已 unlink，目录随 tmpdir 回收
  } catch {
    // 已经不存在
  }
  await rm(path.dirname(channel.path), { recursive: true, force: true }).catch(() => undefined);
}
