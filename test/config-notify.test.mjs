import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../lib/internal.js';

/**
 * 通知配置映射（WS-E）：`src/config.ts` 的 `NotifySettings` 与核心 `notify` YAML 一一对应。
 * 这里机械验证三件事：默认形状、归一化（缺省/垃圾值收敛）、toCoreConfig 原样透传 + 校验。
 */

test('notify 默认关闭、三渠道齐全、字段与 §1.1 对齐', () => {
  const settings = config.normalizeSettings({});
  const n = settings.notify;
  assert.equal(n.enabled, false);
  assert.deepEqual(n.sections, { trending: true, releases: true });
  assert.equal(n.onSkipped, false);
  assert.equal(n.onEmptyReleases, false);
  assert.equal(n.strategy, 'broadcast');
  assert.deepEqual(Object.keys(n.channels).sort(), ['dingtalk', 'lark', 'wecom']);
  assert.equal(n.channels.dingtalk.webhookURL, '${DINGTALK_WEBHOOK}');
  assert.equal(n.channels.dingtalk.secret, '${DINGTALK_SECRET}');
  assert.equal(n.channels.dingtalk.msgtype, 'markdown');
  assert.equal(n.channels.lark.msgtype, 'post');
  assert.equal(n.channels.wecom.msgtype, 'markdown');
  assert.equal(n.maxReposPerSection, 10);
  assert.equal(n.maxBodyChars, 0);
  assert.equal(n.timeoutSeconds, 15);
  assert.equal(n.summaryMaxChars, 800);
});

test('notify 归一化：缺省渠道补默认、非法 strategy 回落、未知字段丢弃', () => {
  const n = config.normalizeSettings({
    notify: {
      enabled: true,
      strategy: 'bogus',
      sections: { trending: false },
      channels: { wecom: { enabled: true, webhookURL: 'https://x/y', msgtype: 'text', extra: 1 } },
      nope: 1,
    },
  }).notify;
  assert.equal(n.enabled, true);
  assert.equal(n.strategy, 'broadcast'); // 非法回落
  assert.equal(n.sections.trending, false);
  assert.equal(n.sections.releases, true); // 缺省保留
  // 只给了 wecom，其余渠道仍补默认存在
  assert.equal(n.channels.dingtalk.enabled, false);
  assert.equal(n.channels.wecom.enabled, true);
  assert.equal(n.channels.wecom.webhookURL, 'https://x/y');
  assert.equal(n.channels.wecom.msgtype, 'text');
  assert.equal('extra' in n.channels.wecom, false);
  assert.equal('nope' in n, false);
});

test('toCoreConfig 原样透传 notify 整段（字段名不翻译、不增不减）', () => {
  const settings = config.normalizeSettings({
    model: { provider: 'deepseek', model: 'deepseek-chat' },
    repo: { path: '/tmp/x' },
    notify: {
      enabled: true,
      onSkipped: true,
      onEmptyReleases: true,
      strategy: 'requireAll',
      channels: {
        dingtalk: { enabled: true, webhookURL: '${DINGTALK_WEBHOOK}', secret: '${DINGTALK_SECRET}', msgtype: 'markdown' },
        lark: { enabled: false },
        wecom: { enabled: true, webhookURL: '${WECOM_WEBHOOK}', secret: '', msgtype: 'text' },
      },
      maxReposPerSection: 5,
      maxBodyChars: 4000,
      timeoutSeconds: 20,
      summaryMaxChars: 600,
    },
  });
  const core = config.toCoreConfig(settings, 'KEY');
  assert.equal(core.notify.enabled, true);
  assert.equal(core.notify.onSkipped, true);
  assert.equal(core.notify.onEmptyReleases, true);
  assert.equal(core.notify.strategy, 'requireAll');
  assert.equal(core.notify.channels.dingtalk.enabled, true);
  assert.equal(core.notify.channels.wecom.msgtype, 'text');
  assert.equal(core.notify.maxReposPerSection, 5);
  assert.equal(core.notify.maxBodyChars, 4000);
  assert.equal(core.notify.summaryMaxChars, 600);
  // 与 NotifyConfig 一一对应：core.notify 键集合固定为这些
  assert.deepEqual(
    Object.keys(core.notify).sort(),
    ['channels', 'enabled', 'maxBodyChars', 'maxReposPerSection', 'onEmptyReleases', 'onSkipped', 'sections', 'strategy', 'summaryMaxChars', 'timeoutSeconds'].sort(),
  );
});

test('notify 段经 toYaml 序列化后含完整嵌套键（密钥仍是 ${VAR} 引用）', () => {
  const settings = config.normalizeSettings({
    model: { provider: 'deepseek', model: 'deepseek-chat' },
    repo: { path: '/tmp/x' },
    notify: { enabled: true, channels: { wecom: { enabled: true, webhookURL: '${WECOM_WEBHOOK}' } } },
  });
  const yaml = config.toYaml(config.toCoreConfig(settings, 'sk'));
  // notify 段及其嵌套渠道字段都写到 YAML 里（形状稳定）。
  assert.match(yaml, /^notify:/m);
  assert.match(yaml, /webhookURL: "\$\{WECOM_WEBHOOK\}"/);
  assert.match(yaml, /msgtype: "markdown"/);
  assert.match(yaml, /strategy: "broadcast"/);
});

test('notify 校验：启用但零渠道 / 零分区、坏 msgtype、越界数值都拦下', () => {
  const base = { model: { provider: 'deepseek', model: 'm' }, repo: { path: '/tmp/x' } };
  // 启用但未开任何渠道
  const noChannel = config.validateSettings(config.normalizeSettings({ ...base, notify: { enabled: true } }), ['deepseek']);
  assert.ok(noChannel.some((p) => p.field === 'notify.channels'));

  // 启用 + 一个渠道，但两个分区都关
  const noSection = config.validateSettings(
    config.normalizeSettings({ ...base, notify: { enabled: true, sections: { trending: false, releases: false }, channels: { wecom: { enabled: true, webhookURL: 'https://x' } } } }),
    ['deepseek'],
  );
  assert.ok(noSection.some((p) => p.field === 'notify.sections'));

  // 坏 msgtype
  const badType = config.validateSettings(
    config.normalizeSettings({ ...base, notify: { channels: { lark: { enabled: true, webhookURL: 'https://x', msgtype: 'bogus' } } } }),
    ['deepseek'],
  );
  assert.ok(badType.some((p) => p.field === 'notify.channels.lark.msgtype'));

  // 启用渠道但缺 webhook
  const noHook = config.validateSettings(
    config.normalizeSettings({ ...base, notify: { channels: { dingtalk: { enabled: true, webhookURL: '' } } } }),
    ['deepseek'],
  );
  assert.ok(noHook.some((p) => p.field === 'notify.channels.dingtalk.webhookURL'));

  // 越界数值
  const badNum = config.validateSettings(
    config.normalizeSettings({ ...base, notify: { summaryMaxChars: 5, timeoutSeconds: 0, maxBodyChars: 10 } }),
    ['deepseek'],
  );
  assert.ok(badNum.some((p) => p.field === 'notify.summaryMaxChars'));
  assert.ok(badNum.some((p) => p.field === 'notify.timeoutSeconds'));
  assert.ok(badNum.some((p) => p.field === 'notify.maxBodyChars'));
});

test('关闭通知时不因未配置渠道阻塞保存（只切总开关的常见路径）', () => {
  const problems = config.validateSettings(
    config.normalizeSettings({ model: { provider: 'deepseek', model: 'm' }, repo: { path: '/tmp/x' }, notify: { enabled: false } }),
    ['deepseek'],
  );
  assert.equal(problems.filter((p) => p.field.startsWith('notify.')).length, 0);
});

test('分段保存：notify 分区只合入 notify，不触碰其它分区', () => {
  const stored = config.normalizeSettings({ model: { provider: 'deepseek', model: 'm' }, repo: { path: '/tmp/a' }, notify: { enabled: false } });
  const incoming = config.normalizeSettings({ model: { provider: 'deepseek', model: 'm' }, repo: { path: '/tmp/b' }, notify: { enabled: true } });
  const merged = config.mergeSettingsSection(stored, incoming, 'notify');
  assert.equal(merged.notify.enabled, true);
  assert.equal(merged.repo.path, '/tmp/a'); // 其它分区保持已保存值
});

test('sectionOfField 把 notify.* 归到 notify 分区', () => {
  assert.equal(config.sectionOfField('notify.enabled'), 'notify');
  assert.equal(config.sectionOfField('notify.channels.wecom.webhookURL'), 'notify');
  assert.equal(config.sectionOfField('notify.sections'), 'notify');
  assert.equal(config.sectionOfField('releases.period'), 'releases');
});
