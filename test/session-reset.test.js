import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionTransitionSequence, SessionEpoch } from '../src/session-reset.js';

function createHarness(timings = { dissolveMs: 1200, settlePauseMs: 200, emergeMs: 1050 }) {
  const log = [];
  let now = 0;
  let seqId = 0;
  const timers = new Map();

  const clock = {
    now: () => now,
    schedule: (fn, ms) => {
      const id = ++seqId;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    cancel: (handle) => timers.delete(handle),
  };

  const exec = {};
  const pending = { dissolve: null, leaf: null, emerge: null };
  for (const name of ['cancelInflight', 'dissolvePages', 'blankRightPage', 'playLeaf', 'unlockInput', 'emergeLeftHistory', 'settleAtOnce']) {
    exec[name] = (...args) => {
      log.push(`${name}@${now}`);
      if (name === 'dissolvePages') pending.dissolve = args[1];
      if (name === 'playLeaf') pending.leaf = args[0];
      if (name === 'emergeLeftHistory') pending.emerge = args[1];
    };
  }

  function advance(ms) {
    const target = now + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of timers) {
        if (t.at <= target && (!next || t.at < next[1].at)) next = [id, t];
      }
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
    }
    now = target;
  }

  return {
    log,
    now: () => now,
    advance,
    completeDissolve: () => pending.dissolve?.(),
    completeLeaf: () => pending.leaf?.(),
    completeEmerge: () => pending.emerge?.(),
    sequence: new SessionTransitionSequence({ clock, timings, exec }),
  };
}

test('有墨时按 吸干→换纸→静置→整页复显 串行推进', () => {
  const h = createHarness();
  const s = h.sequence;

  assert.equal(s.begin(true), true);
  assert.equal(s.phase, 'dissolving');

  h.advance(700);
  s.openLeafGate();
  assert.equal(s.phase, 'dissolving', '蘸墨先落定也不能让叶片抢跑');
  assert.ok(!h.log.includes('playLeaf@700'));

  h.advance(500);
  h.completeDissolve();
  assert.deepEqual(h.log, ['cancelInflight@0', 'dissolvePages@0', 'blankRightPage@1200', 'playLeaf@1200']);
  assert.equal(s.phase, 'turning');

  h.completeLeaf();
  assert.equal(s.phase, 'settling');
  assert.ok(h.log.includes('unlockInput@1200'), '落定即解除输入锁定');

  h.advance(199);
  assert.equal(s.phase, 'settling', '静置 200ms 之内不起复显');
  h.advance(1);
  assert.equal(s.phase, 'emerging');
  assert.equal(h.now(), 1400);

  h.advance(1050);
  h.completeEmerge();
  assert.equal(s.phase, 'idle');
});

test('蘸墨比吸干更慢时换纸等门放行', () => {
  const h = createHarness();
  const s = h.sequence;

  s.begin(true);
  h.advance(1200);
  h.completeDissolve();
  assert.equal(s.phase, 'gating');
  assert.ok(!h.log.some((l) => l.startsWith('playLeaf')));

  h.advance(300);
  s.openLeafGate();
  assert.equal(s.phase, 'turning');
  assert.ok(h.log.includes('playLeaf@1500'));
});

test('纸面全空时退化为只演换纸，不演吸干与复显', () => {
  const h = createHarness();
  const s = h.sequence;

  s.begin(false);
  assert.equal(s.phase, 'gating');
  assert.ok(!h.log.some((l) => l.startsWith('dissolvePages')));

  h.advance(700);
  s.openLeafGate();
  assert.deepEqual(h.log, ['cancelInflight@0', 'blankRightPage@700', 'playLeaf@700']);

  h.completeLeaf();
  assert.equal(s.phase, 'idle');
  assert.ok(h.log.includes('unlockInput@700'));
  assert.ok(!h.log.some((l) => l.startsWith('emergeLeftHistory')));
});

test('合书出口把转场瞬清到终态并丢弃后续阶段', () => {
  const h = createHarness();
  const s = h.sequence;

  s.begin(true);
  h.advance(1200);
  h.completeDissolve();
  s.openLeafGate();
  h.completeLeaf();
  assert.equal(s.phase, 'settling');

  s.abort();
  assert.equal(s.phase, 'idle');
  assert.ok(h.log.includes('settleAtOnce@1200'));

  h.advance(5000);
  assert.equal(h.log.filter((l) => l.startsWith('emergeLeftHistory')).length, 0, '静置计时器必须被抹除');
});

test('空闲态的 abort 不产生任何终态副作用，转场进行中拒绝重复触发', () => {
  const h = createHarness();
  const s = h.sequence;

  s.abort();
  assert.equal(h.log.length, 0);

  s.begin(true);
  assert.equal(s.begin(true), false, '转场期间再次点瓶不受理');
  assert.equal(h.log.filter((l) => l.startsWith('cancelInflight')).length, 1);
});

test('世代作废让上一代演出与迟到的回复无法落在新纸上', () => {
  const epoch = new SessionEpoch();
  const landed = [];

  const oldAiPage = epoch.guard((page) => landed.push(`ai:${page}`));
  epoch.advance();
  oldAiPage(3);
  assert.deepEqual(landed, [], '换页复显之后旧世代的 AI 分页链必须自弃');

  const newReply = epoch.guard((text) => landed.push(`reply:${text}`));
  newReply('新世代');
  assert.deepEqual(landed, ['reply:新世代']);

  epoch.advance();
  newReply('迟到第二次');
  assert.deepEqual(landed, ['reply:新世代'], '再次作废后旧回调同样失效');
});

test('guard 透传参数与返回值供同世代内正常串联', () => {
  const epoch = new SessionEpoch();
  const wrapped = epoch.guard((a, b) => a + b);
  assert.equal(wrapped(2, 3), 5);
});

test('guard 的 arity 陷阱：延时误挂到 guard 上即刻报错，而不是静默退化成 0ms', () => {
  const epoch = new SessionEpoch();
  assert.throws(() => epoch.guard(() => {}, 3200), TypeError);
  assert.doesNotThrow(() => epoch.guard(() => {}));
});

test('切换 Session 时播放 backward 翻页动画，免门控直接换纸并反向显影双页', () => {
  let leafDirection = null;
  const exec = {
    cancelInflight: () => {},
    dissolvePages: (ms, done) => done(),
    prepareSwap: () => {},
    playLeaf: ({ direction }, done) => {
      leafDirection = direction;
      done();
    },
    unlockInput: () => {},
    emergePages: (ms, done) => done(),
    settleAtOnce: () => {},
  };
  let now = 0;
  const clock = {
    now: () => now,
    schedule: (fn, ms) => {
      fn();
      return 1;
    },
    cancel: () => {},
  };
  const s = new SessionTransitionSequence({
    clock,
    timings: { dissolveMs: 300, settlePauseMs: 50, emergeMs: 300 },
    exec,
  });

  const started = s.begin({ direction: 'backward', hasInk: true, requiresGate: false });
  assert.equal(started, true);
  assert.equal(leafDirection, 'backward', '切换 session 必须传递 backward 翻页方向');
  assert.equal(s.phase, 'idle', '无阻断状态下完整走完所有阶段回到 idle');
});
