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
    assert.equal(handle.requests, 1);
  } finally {
    await handle.close();
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
