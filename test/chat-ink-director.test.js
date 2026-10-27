import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatInkDirector, calculateAiPageStayMs } from '../src/chat-ink-director.js';
import { InkSessionModel } from '../src/ink-session.js';
import { SessionEpoch } from '../src/session-reset.js';

function createDirectorHarness(options = {}) {
  const log = [];
  let now = 0;
  let timerId = 0;
  const timers = new Map();

  const clock = {
    now: () => now,
    schedule: (fn, ms) => {
      const id = ++timerId;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    cancel: (handle) => timers.delete(handle),
  };

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

  const epoch = new SessionEpoch();
  const sessionModel = new InkSessionModel({
    textMeasurer: (text) => [{ start: 0, end: text.length, text }],
    historyCapacity: 5,
  });

  const pending = { erosionDone: null, emergenceDone: null };

  const displayPort = {
    animateTextErosion: (duration, done) => {
      log.push(`erode@${now}:${duration}`);
      pending.erosionDone = done;
      return () => {
        log.push(`cancelErosion@${now}`);
        pending.erosionDone = null;
      };
    },
    animateTextEmergence: (duration, done) => {
      log.push(`emerge@${now}:${duration}`);
      pending.emergenceDone = done;
      return () => {
        log.push(`cancelEmergence@${now}`);
        pending.emergenceDone = null;
      };
    },
    dissolveLeftInitialTitle: (duration, done) => {
      log.push(`dissolveLeftInitialTitle@${now}:${duration}`);
      return () => {
        log.push(`cancelLeftDissolve@${now}`);
      };
    },
    prepareLeftItemEmergence: (histItem) => {
      log.push(`prepareLeftItem@${now}:${histItem.id}`);
    },
    animateLeftItemEmergence: (histItem, duration) => {
      log.push(`animateLeftItem@${now}:${histItem.id}:${duration}`);
      return () => {};
    },
    setRenderText: (text, isAi) => {
      log.push(`renderText@${now}:${isAi ? 'AI' : 'User'}:${text}`);
    },
    redrawCanvas: () => {
      log.push(`redraw@${now}`);
    },
  };

  const inputPort = {
    lock: () => log.push(`lockInput@${now}`),
    unlock: () => log.push(`unlockInput@${now}`),
    syncDraft: (text, cursor) => log.push(`syncDraft@${now}:${text}:${cursor}`),
  };

  const dropPort = {
    start: (delay) => log.push(`startDrop@${now}:${delay}`),
    stop: () => log.push(`stopDrop@${now}`),
  };

  const director = new ChatInkDirector({
    sessionModel,
    epoch,
    clock,
    promptPort: options.promptPort || (async (p) => `回答：${p}`),
    validatePort: options.validatePort,
    onCancel: options.onCancel,
    displayPort,
    inputPort,
    dropPort,
    config: options.config,
    onPhaseChange: (phase) => log.push(`phase@${now}:${phase}`),
  });

  return {
    director,
    sessionModel,
    epoch,
    clock,
    log,
    now: () => now,
    advance,
    triggerErosionDone: () => pending.erosionDone?.(),
    triggerEmergenceDone: () => pending.emergenceDone?.(),
  };
}

test('ChatInkDirector 完整对话墨迹演播生命周期: 提交→微渗定格→消融→网络返回→显影→字数阅读→吸干归还', async () => {
  const h = createDirectorHarness();
  const d = h.director;

  assert.equal(d.phase, 'idle');
  assert.equal(d.isBusy, false);

  const accepted = d.submit('你好里德尔');
  assert.equal(accepted, true);
  assert.equal(d.phase, 'eroding_prompt');
  assert.equal(d.isBusy, true);
  assert.ok(h.log.includes('lockInput@0'));
  assert.ok(h.log.includes('stopDrop@0'));

  // 150ms stayTime 到达，启动消融动画
  h.advance(150);
  assert.ok(h.log.includes('erode@150:2400'));

  // 完成消融
  await h.triggerErosionDone();
  assert.equal(d.phase, 'emerging_reply');
  assert.ok(h.log.includes('renderText@150:AI:回答：你好里德尔'));
  assert.ok(h.log.includes('emerge@150:2200'));

  // 显影完成，进入 reading_reply 阶段
  h.triggerEmergenceDone();
  assert.equal(d.phase, 'reading_reply');

  // 计算停留时长 (9 个字，单页终页保底 4200ms)
  const stay = calculateAiPageStayMs('回答：你好里德尔'.length, true);
  assert.equal(stay, 4200);

  // 推进 4200ms，开始末页吸干
  h.advance(stay);
  assert.equal(d.phase, 'eroding_reply');
  assert.ok(h.log.includes(`erode@${150 + stay}:2400`));

  // 末页吸干完成，等待 pageTurnPause 留白微间隔
  h.triggerErosionDone();
  h.advance(200);

  // 归还纸面并解锁输入与滴墨
  assert.equal(d.phase, 'idle');
  assert.equal(d.isBusy, false);
  assert.ok(h.log.includes(`renderText@${150 + stay + 200}:User:`));
  assert.ok(h.log.includes(`unlockInput@${150 + stay + 200}`));
  assert.ok(h.log.includes(`startDrop@${150 + stay + 200}:0`));
});

test('世代作废保护 (Session Epoch Void): 网络挂起期间换页使旧回复自行动作废', async () => {
  let resolvePrompt;
  const promptPromise = new Promise((res) => {
    resolvePrompt = res;
  });

  const h = createDirectorHarness({
    promptPort: () => promptPromise,
  });

  h.director.submit('旧世代提问');
  h.advance(150);

  // 推进消融完成，进入 awaiting_reply 阶段
  const erosionPromise = h.triggerErosionDone();
  assert.equal(h.director.phase, 'awaiting_reply');

  // 用户点击墨水瓶换页，世代自增
  h.epoch.advance();

  // 迟到的网络回复此时返回
  resolvePrompt('迟到的里德尔回复');
  await erosionPromise;

  // 必须直接作废，不得进入显影阶段，不得沉淀入历史
  assert.equal(h.director.phase, 'idle');
  assert.ok(!h.log.some((entry) => entry.includes('renderText') && entry.includes('迟到的里德尔回复')));
  assert.equal(h.sessionModel.sessionHistory.length, 0);
});

test('历史回顾演播 (History Replay) 与用户打断草稿无损复原', () => {
  const h = createDirectorHarness();
  const d = h.director;

  // 预置一条历史记录
  const histItem = h.sessionModel.addHistory('历史提问', '历史回答');
  h.sessionModel.setInput('未提交草稿文本', 5);

  const started = d.startReplay(histItem, 5);
  assert.equal(started, true);
  assert.equal(d.phase, 'replaying');
  assert.equal(d.isReplaying, true);
  assert.ok(h.log.includes('lockInput@0'));

  // 先 400ms 吸干草稿
  assert.ok(h.log.includes('erode@0:400'));
  h.triggerErosionDone();

  // 进入历史提问显影
  assert.ok(h.log.includes('renderText@0:User:历史提问'));
  assert.ok(h.log.includes('emerge@0:2200'));

  // 用户主动打断历史演播（带 400ms 快吸）
  d.interruptReplay(false);
  assert.ok(h.log.includes('erode@0:400'));

  h.triggerErosionDone();
  assert.equal(d.phase, 'idle');
  assert.equal(d.isReplaying, false);
  // 必须无损复原草稿与光标
  assert.ok(h.log.includes('syncDraft@0:未提交草稿文本:5'));
  assert.ok(h.log.includes('unlockInput@0'));
  assert.ok(h.log.includes('startDrop@0:1200'));
});

test('ChatInkDirector 默认时钟必须规避浏览器 window.setTimeout 的 Illegal invocation (this 丢失)', () => {
  // 模拟浏览器 window 宿主对象：如果在对象解构或作为 clock 方法调用时 this 不是 window，浏览器会直接抛出 Illegal invocation
  const fakeWindow = {
    setTimeout(fn, ms) {
      if (this !== fakeWindow) {
        throw new TypeError('Illegal invocation');
      }
      return 1;
    },
    clearTimeout(id) {
      if (this !== fakeWindow) {
        throw new TypeError('Illegal invocation');
      }
    },
  };

  // 1. 如果直接写成 { schedule: fakeWindow.setTimeout }，会丢失 this 并抛出 Illegal invocation
  const naiveClock = {
    now: () => 0,
    schedule: fakeWindow.setTimeout,
    cancel: fakeWindow.clearTimeout,
  };
  const brokenDirector = new ChatInkDirector({
    sessionModel: new InkSessionModel({ textMeasurer: () => [], historyCapacity: 5 }),
    epoch: new SessionEpoch(),
    clock: naiveClock,
    displayPort: {
      animateTextErosion: () => () => {},
      animateTextEmergence: () => () => {},
      setRenderText: () => {},
    },
  });
  assert.throws(
    () => {
      brokenDirector.submit('hello');
    },
    {
      name: 'TypeError',
      message: 'Illegal invocation',
    }
  );

  // 2. 默认时钟必须采用函数包裹 (fn, ms) => setTimeout(fn, ms)，即使在 window 环境下也不会作为 clock 的方法导致 this 被替换为 clock
  const director = new ChatInkDirector({
    sessionModel: new InkSessionModel({ textMeasurer: () => [], historyCapacity: 5 }),
    epoch: new SessionEpoch(),
    displayPort: {
      animateTextErosion: () => () => {},
      animateTextEmergence: () => () => {},
      setRenderText: () => {},
    },
  });

  assert.doesNotThrow(() => {
    director.submit('hello');
  });
});

test('ChatInkDirector 提问消融时联动触发左页初始标题吸干消融与取消', async () => {
  const h = createDirectorHarness();
  const d = h.director;

  d.submit('你好里德尔');
  h.advance(150);

  // 必须同时记录右页消融与左页标题消融
  assert.ok(h.log.includes('erode@150:2400'));
  assert.ok(h.log.includes('dissolveLeftInitialTitle@150:2400'));

  // cancelAll 必须联动取消左页消融
  d.cancelAll();
  assert.ok(h.log.includes('cancelLeftDissolve@150'));
  assert.ok(h.log.includes('cancelErosion@150'));
});

test('ChatInkDirector cancelAll 支持 preserveText 选项保留当前文字供消融演播', () => {
  const h = createDirectorHarness();
  const d = h.director;
  h.sessionModel.setInput('右页文字', 4);
  d.displayPort.setRenderText('右页文字', false);

  const prevLen = h.log.length;
  d.cancelAll({ preserveText: true });
  const clearAfter = h.log.slice(prevLen).some((entry) => entry.startsWith('renderText') && entry.includes('User:'));
  assert.equal(clearAfter, false, 'preserveText 为 true 时不应清空当前文本');

  d.cancelAll();
  assert.ok(h.log.includes('renderText@0:User:'), '默认 cancelAll 必须清空文本');
});

test('ChatInkDirector validatePort 预检不就绪时拒绝提交并完好保留草稿', () => {
  const h = createDirectorHarness({
    validatePort: () => ({ ready: false, reason: 'GENERATING' }),
  });
  const d = h.director;
  h.sessionModel.setInput('保留的草稿', 5);

  const accepted = d.submit('保留的草稿');
  assert.equal(accepted, false);
  assert.equal(d.phase, 'idle');
  // 草稿未被清空，未触发锁定与消融
  assert.equal(h.sessionModel.inputBuffer, '保留的草稿');
  assert.ok(!h.log.some((l) => l.startsWith('lockInput')));
  assert.ok(!h.log.some((l) => l.startsWith('syncDraft@0::0')));
});

test('ChatInkDirector promptPort 异常时反向显影魔法错误提示', async () => {
  const h = createDirectorHarness({
    promptPort: async () => {
      throw new Error('Network timeout');
    },
  });
  const d = h.director;

  d.submit('测试超时提问');
  h.advance(150);
  h.triggerErosionDone();

  await new Promise((r) => setTimeout(r, 10));
  h.advance(0);

  // 必须显影魔法错误提示
  assert.ok(h.log.some((l) => l.includes('墨水沉入纸背，未见回响……')));
});

test('ChatInkDirector cancelAll 时触发 onCancel 通知', () => {
  let cancelCalled = false;
  const h = createDirectorHarness({
    onCancel: () => { cancelCalled = true; },
  });
  const d = h.director;

  d.submit('测试取消提问');
  d.cancelAll();

  assert.equal(cancelCalled, true);
});

