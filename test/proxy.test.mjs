import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proxy } from '../lib/internal.js';

function stubLlm(reply = '你好，世界') {
  return {
    calls: [],
    async *stream(options) {
      this.calls.push(options);
      yield { type: 'text-delta', index: 0, text: reply.slice(0, 2) };
      yield { type: 'text-delta', index: 0, text: reply.slice(2) };
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

test('代理只接受带一次性 token 的请求，并转发 system/user', async () => {
  const llm = stubLlm();
  const handle = await proxy.startProxy({ llm, provider: 'magpie', model: 'deepseek/deepseek-flash' });
  try {
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    const unauthorized = await fetch(`${handle.url}/chat/completions`, { method: 'POST', body: '{}' });
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${handle.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
      body: JSON.stringify({
        model: 'whatever',
        messages: [
          { role: 'system', content: 'you are terse' },
          { role: 'user', content: [{ type: 'text', text: '写一句话' }] },
        ],
        temperature: 0.1,
        max_tokens: 64,
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.choices[0].message.content, '你好，世界');
    assert.equal(payload.usage.total_tokens, 8);
    assert.equal(llm.calls.length, 1);
    assert.equal(llm.calls[0].provider, 'magpie');
    assert.equal(llm.calls[0].system, 'you are terse');
    assert.equal(llm.calls[0].messages[0].content[0].text, '写一句话');
    // 会话标识必须透传给宿主：opencode-go 等网关缺它会 400 MissingSessionID。
    assert.match(llm.calls[0].sessionId, /^dsh-github-trending-[0-9a-f-]{36}$/);
    assert.equal(handle.requests, 1);
  } finally {
    await handle.close();
  }
});

test('同一代理的多次转发共享一个 sessionId；不同代理各自独立', async () => {
  const llm = stubLlm();
  const send = async (handle) => {
    const response = await fetch(`${handle.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }] }),
    });
    assert.equal(response.status, 200);
  };
  const first = await proxy.startProxy({ llm, provider: 'opencode-go', model: 'deepseek-v4-pro' });
  const second = await proxy.startProxy({ llm, provider: 'opencode-go', model: 'other' });
  try {
    await send(first);
    await send(first);
    await send(second);
    assert.equal(llm.calls.length, 3);
    // 网关按会话路由：同一代理必须复用同一个会话，不同代理不能串会话。
    assert.equal(llm.calls[0].sessionId, llm.calls[1].sessionId);
    assert.notEqual(llm.calls[0].sessionId, llm.calls[2].sessionId);
  } finally {
    await first.close();
    await second.close();
  }
});

test('代理拒绝流式请求，并如实返回模型失败', async () => {
  const llm = {
    async *stream() {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'bad key' } } };
    },
  };
  const handle = await proxy.startProxy({ llm, provider: 'p', model: 'm' });
  try {
    const streaming = await fetch(`${handle.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'x' }] }),
    });
    assert.equal(streaming.status, 400);

    const failed = await fetch(`${handle.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
    });
    assert.equal(failed.status, 502);
    assert.equal((await failed.json()).error.code, 'AUTH');
  } finally {
    await handle.close();
  }
  await assert.rejects(fetch(`${handle.url}/healthz`));
});

test('foldMessages 把多轮并进单个 user，system 单独抽出', () => {
  const folded = proxy.foldMessages([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
  ]);
  assert.equal(folded.system, 'sys');
  assert.equal(folded.user, 'a\n\nb');
});

test('ProxyPool：不同 provider/model 各起代理，同目标复用；closeAll 全部释放', async () => {
  const llm = stubLlm();
  const pool = new proxy.ProxyPool(llm);
  try {
    const a = await pool.acquire({ provider: 'magpie', model: 'm1' });
    // 同 provider+model → 复用同一个实例（同端口同 token）
    const a2 = await pool.acquire({ provider: 'magpie', model: 'm1' });
    assert.equal(a, a2);
    assert.equal(a.port, a2.port);
    // 同 provider 不同 model → 另起一个（不同端口）
    const b = await pool.acquire({ provider: 'magpie', model: 'm2' });
    assert.notEqual(a.port, b.port);
    // 不同 provider 同 model → 也另起
    const c = await pool.acquire({ provider: 'deepseek', model: 'm1' });
    assert.notEqual(a.port, c.port);
    assert.equal(pool.size, 3);
    // 每个代理各自校验自己的 token，路由到正确的 provider/model
    for (const [handle, provider, model] of [[a, 'magpie', 'm1'], [b, 'magpie', 'm2'], [c, 'deepseek', 'm1']]) {
      const res = await fetch(`${handle.url}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });
      assert.equal(res.status, 200);
    }
    const routed = llm.calls.map((call) => `${call.provider}/${call.model}`);
    assert.deepEqual(routed, ['magpie/m1', 'magpie/m2', 'deepseek/m1']);
    // 用 A 的 token 打 B 的端口 → 401（一次性 token 不串味）
    const crossed = await fetch(`${b.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${a.token}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(crossed.status, 401);
  } finally {
    await pool.closeAll();
  }
  // closeAll 后所有端口都释放
  assert.equal(pool.size, 0);
});

test('P1：onEvent 上报 recv/ok，成功路径可观测', async () => {
  const events = [];
  const handle = await proxy.startProxy({
    llm: stubLlm('abc'),
    provider: 'magpie',
    model: 'group/workbuddy',
    onEvent: (event) => events.push(event),
  });
  try {
    const response = await fetch(`${handle.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(events.map((event) => event.kind), ['recv', 'ok']);
    assert.equal(events[0].provider, 'magpie');
    assert.equal(events[0].model, 'group/workbuddy');
    assert.equal(typeof events[1].durationMs, 'number');
  } finally {
    await handle.close();
  }
});

test('P1：onEvent 上报 fail，带 code 与 message', async () => {
  const events = [];
  const llm = {
    async *stream() {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'bad key' } } };
    },
  };
  const handle = await proxy.startProxy({ llm, provider: 'p', model: 'm', onEvent: (event) => events.push(event) });
  try {
    const response = await fetch(`${handle.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 502);
    const fail = events.find((event) => event.kind === 'fail');
    assert.ok(fail, '应有 fail 事件');
    assert.equal(fail.code, 'AUTH');
    assert.equal(fail.message, 'bad key');
  } finally {
    await handle.close();
  }
});
