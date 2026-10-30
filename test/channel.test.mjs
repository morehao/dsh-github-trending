import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { channel } from '../lib/internal.js';

test('FIFO 通道：写进去的内容能被读端完整拿到', async () => {
  const configChannel = await channel.openConfigChannel();
  assert.equal(configChannel.kind, 'fifo');
  const payload = 'model:\n  provider: "deepseek"\n  apiKey: "sk-secret"\n';
  // 读端模拟核心：os.ReadFile 语义 = 打开、读完、关闭
  const reader = spawn(process.execPath, ['-e', `const fs=require('fs');process.stdout.write(fs.readFileSync(${JSON.stringify(configChannel.path)},'utf8'))`]);
  let out = '';
  reader.stdout.setEncoding('utf8');
  reader.stdout.on('data', (chunk) => { out += chunk; });
  await configChannel.publish(payload);
  await new Promise((resolve) => reader.on('close', resolve));
  assert.equal(out, payload);
  await configChannel.dispose();
});

test('preferFifo=false 时退回 0600 临时文件，并在 dispose 后删除', async () => {
  const configChannel = await channel.openConfigChannel({ preferFifo: false });
  assert.equal(configChannel.kind, 'tmpfile');
  await configChannel.publish('a: 1\n');
  const fs = await import('node:fs');
  assert.equal(fs.readFileSync(configChannel.path, 'utf8'), 'a: 1\n');
  const mode = fs.statSync(configChannel.path).mode & 0o777;
  assert.equal(mode, 0o600);
  await configChannel.dispose();
  assert.equal(fs.existsSync(configChannel.path), false);
});

test('没有读端时按写超时报错，而不是永远挂住', { skip: process.platform === 'win32' }, async () => {
  const configChannel = await channel.openConfigChannel({ writeTimeoutMs: 300 });
  const started = Date.now();
  await assert.rejects(async () => {
    await configChannel.publish('x: 1\n');
  }, /FIFO 写超时/);
  assert.ok(Date.now() - started >= 250);
  await configChannel.dispose();
});
