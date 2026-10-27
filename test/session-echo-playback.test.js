import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SessionEchoPlayback,
  layoutEchoMessages,
  DEFAULT_ECHO_CONFIG,
} from '../src/session-echo-playback.js';

class MockClock {
  constructor() {
    this.currentTime = 0;
    this.timers = [];
    this.nextId = 1;
  }

  now() {
    return this.currentTime;
  }

  schedule(fn, ms) {
    const id = this.nextId++;
    this.timers.push({ id, runAt: this.currentTime + ms, fn });
    this.timers.sort((a, b) => a.runAt - b.runAt);
    return id;
  }

  cancel(id) {
    this.timers = this.timers.filter((t) => t.id !== id);
  }

  tick(ms) {
    const target = this.currentTime + ms;
    while (this.timers.length > 0 && this.timers[0].runAt <= target) {
      const next = this.timers.shift();
      this.currentTime = next.runAt;
      next.fn();
    }
    this.currentTime = target;
  }
}

test('layoutEchoMessages 动态排版与单条长消息跨页拆分', () => {
  const leftPage = { x: 100, y: 100, w: 400, h: 200 };
  const rightPage = { x: 600, y: 100, w: 400, h: 200 };

  // mock wrapText: 每 10 个字符一行
  const wrapText = (text) => {
    const lines = [];
    for (let i = 0; i < text.length; i += 10) {
      lines.push(text.slice(i, i + 10));
    }
    return lines.length ? lines : [''];
  };

  const messages = [
    { role: 'user', text: '短提问' }, // 1 行，高度 44
    { role: 'ai', text: '这是一个非常非常长的回答，足足跨越好多行，而且还有更多内容' }, // 3 行，高度 132
  ];

  // leftPage h = 200, padTop=12, padBottom=12 => 可用高度 176
  // 第一条 44 + 间距 14 => 占用 58，剩余 118。
  // 第二条需 132 (3行)。剩余只能容纳 2 行 (88px)。
  // 因此第二条必定跨页切分：左页 2 行，右页 1 行！
  const items = layoutEchoMessages(messages, {
    leftPage,
    rightPage,
    wrapText,
    config: {
      ...DEFAULT_ECHO_CONFIG,
      lineHeight: 44,
      paragraphSpacing: 14,
      paddingTop: 12,
      paddingBottom: 12,
    },
  });

  assert.equal(items.length, 2);
  assert.equal(items[0].fragments.length, 1);
  assert.equal(items[0].fragments[0].page, 'left');
  assert.equal(items[0].fragments[0].lines.length, 1);

  // 第二条消息跨页
  assert.equal(items[1].fragments.length, 2);
  assert.equal(items[1].fragments[0].page, 'left');
  assert.equal(items[1].fragments[0].lines.length, 2, '左页底部容纳前 2 行');
  assert.equal(items[1].fragments[1].page, 'right');
  assert.equal(items[1].fragments[1].lines.length, 1, '右页顶部容纳后 1 行');
});

test('SessionEchoPlayback 时序步进与生命周期 (反显 -> 延时 -> 消融)', () => {
  const clock = new MockClock();
  const leftPage = { x: 100, y: 100, w: 400, h: 600 };
  const rightPage = { x: 600, y: 100, w: 400, h: 600 };
  const wrapText = (t) => [t];

  let frameFragments = [];
  let completed = false;

  const playback = new SessionEchoPlayback({
    clock,
    config: {
      emergeDuration: 500,
      stayDuration: 600,
      dissolveDuration: 500,
      staggerMs: 200,
      lineHeight: 44,
      paragraphSpacing: 10,
    },
    layoutPort: { leftPage, rightPage, wrapText },
    renderPort: {
      onRenderFrame: (frags) => {
        frameFragments = frags;
      },
      onComplete: () => {
        completed = true;
      },
    },
  });

  const history = [
    { prompt: '问一', reply: '答一' },
  ];

  playback.start(history);

  // t = 50: 第 1 条 (问一) 处于反显早期
  clock.tick(50);
  playback.step(clock.now());
  assert.equal(playback.isActive, true);
  assert.equal(frameFragments.length, 1);
  assert.equal(frameFragments[0].role, 'user');
  assert.ok(frameFragments[0].opacity > 0 && frameFragments[0].opacity < 1);

  // t = 250: 第 2 条 (答一) 启动 (比上一条晚 200ms)
  clock.tick(200);
  playback.step(clock.now());
  assert.equal(frameFragments.length, 2, '此时第 1 条与第 2 条并发渲染');
  assert.equal(frameFragments[0].role, 'user');
  assert.equal(frameFragments[1].role, 'ai');
  assert.ok(frameFragments[1].opacity > 0);

  // t = 800: 第 1 条进入定格停留 (500~1100ms 间 opacity = 1.0)
  clock.tick(600); // 200 + 600 = 800
  playback.step(clock.now());
  assert.equal(frameFragments[0].opacity, 1.0, '第 1 条饱满定格');

  // t = 1600: 第 1 条消融完毕 (500+600+500 = 1600ms)
  clock.tick(800); // 800 + 800 = 1600
  playback.step(clock.now());
  assert.equal(frameFragments.some((f) => f.role === 'user'), false, '第 1 条已完全消融消失');
  assert.equal(frameFragments.some((f) => f.role === 'ai'), true, '第 2 条仍在消融期');

  // t = 1800: 第 2 条消融完毕 (200 + 1600 = 1800ms)
  clock.tick(200);
  playback.step(clock.now());
  assert.equal(completed, true, '所有消息消融完毕，触发 onComplete');
  assert.equal(playback.isActive, false);
});

test('SessionEchoPlayback 第二轮循环覆盖时消融等待门控 (必须等目标位置消融完毕)', () => {
  const clock = new MockClock();
  // 构造小页面：每页只能容纳 1 条消息（h=60, lineH=44）
  const leftPage = { x: 100, y: 100, w: 400, h: 60 };
  const rightPage = { x: 600, y: 100, w: 400, h: 60 };
  const wrapText = (t) => [t];

  const playback = new SessionEchoPlayback({
    clock,
    config: {
      emergeDuration: 500,
      stayDuration: 600,
      dissolveDuration: 500, // 单条总耗时 1600ms
      staggerMs: 200,
      lineHeight: 44,
      paragraphSpacing: 10,
    },
    layoutPort: { leftPage, rightPage, wrapText },
    renderPort: {
      onRenderFrame: () => {},
      onComplete: () => {},
    },
  });

  // 3 条消息：
  // Msg 0 (user): 左页 Round 0
  // Msg 1 (ai): 右页 Round 0
  // Msg 2 (user): 回到左页 Round 1 (第二轮目标位置与 Msg 0 垂直重叠！)
  const history = [
    { prompt: '问一', reply: '答一' },
    { prompt: '问二', reply: '' },
  ];

  playback.start(history);

  // t = 0: Msg 0 在左页启动
  assert.equal(playback._items[0].state, 'active');

  // t = 200: Msg 1 在右页启动
  clock.tick(200);
  assert.equal(playback._items[1].state, 'active');

  // t = 400: Msg 2 尝试在左页启动
  // 但是 Msg 0 此时只运行了 400ms (总需 1600ms)，左页目标位置尚未消融完毕！
  clock.tick(200);
  assert.equal(playback._items[2].state, 'waiting_gate', 'Msg 2 必须进入门控等待');

  // t = 1000: Msg 0 运行到 1000ms，仍在定格期，Msg 2 依然等待
  clock.tick(600);
  playback.step(clock.now());
  assert.equal(playback._items[2].state, 'waiting_gate');

  // t = 1600: Msg 0 达到 1600ms，消融完成！
  clock.tick(600);
  playback.step(clock.now());
  assert.equal(playback._items[0].state, 'completed');
  assert.equal(playback._items[2].state, 'active', 'Msg 0 消融完毕后立即放行 Msg 2 反显');
});

test('SessionEchoPlayback 用户即时打断 (interrupt)', () => {
  const clock = new MockClock();
  const leftPage = { x: 100, y: 100, w: 400, h: 400 };
  const rightPage = { x: 600, y: 100, w: 400, h: 400 };
  let cleared = false;
  let completed = false;

  const playback = new SessionEchoPlayback({
    clock,
    layoutPort: { leftPage, rightPage, wrapText: (t) => [t] },
    renderPort: {
      onClear: () => {
        cleared = true;
      },
      onComplete: () => {
        completed = true;
      },
    },
  });

  playback.start([{ prompt: '问', reply: '答' }]);
  assert.equal(playback.isActive, true);

  playback.interrupt();
  assert.equal(playback.isActive, false);
  assert.equal(cleared, true, '立即清理纸面');
  assert.equal(completed, true, '立即触发终态收束');
});

test('SessionEchoPlayback 活跃片段必须提供生命周期阶段与消融度量，用于毛细显影与形态学消融', () => {
  const clock = new MockClock();
  const leftPage = { x: 100, y: 100, w: 400, h: 400 };
  const rightPage = { x: 600, y: 100, w: 400, h: 400 };

  let lastFragments = [];
  const playback = new SessionEchoPlayback({
    clock,
    config: {
      emergeDuration: 400,
      stayDuration: 800,
      dissolveDuration: 400,
    },
    layoutPort: { leftPage, rightPage, wrapText: (t) => [t] },
    renderPort: {
      onRenderFrame: (fragments) => {
        lastFragments = fragments;
      },
    },
  });

  playback.start([{ prompt: 'Hello', reply: '' }]);

  // t = 100ms: 反显阶段 (emerge: dissolveAmount 从 1.0 走向 0.0)
  clock.tick(100);
  playback.step(clock.now());
  assert.equal(lastFragments.length, 1);
  const fEmerge = lastFragments[0];
  assert.equal(fEmerge.phase, 'emerge');
  assert.ok(fEmerge.dissolveAmount > 0.0 && fEmerge.dissolveAmount < 1.0);

  // t = 600ms: 定格阶段 (stay: dissolveAmount == 0.0，饱满墨色)
  clock.tick(500);
  playback.step(clock.now());
  const fStay = lastFragments[0];
  assert.equal(fStay.phase, 'stay');
  assert.equal(fStay.dissolveAmount, 0.0);

  // t = 1400ms: 消融阶段 (dissolve: dissolveAmount 从 0.0 走向 1.0)
  clock.tick(800);
  playback.step(clock.now());
  const fDissolve = lastFragments[0];
  assert.equal(fDissolve.phase, 'dissolve');
  assert.ok(fDissolve.dissolveAmount > 0.0 && fDissolve.dissolveAmount < 1.0);
});

test('applyMorphologicalDissolution 基于骨架场中轴收缩与双色相渐变（严禁简单透明度淡化）', async () => {
  const { applyMorphologicalDissolution } = await import('../src/ink-rasterizer.js');

  // 构建 3x1 的微型像素区域：
  // 像素 0: 轮廓边缘 (skeleton = 30)
  // 像素 1: 次中轴 (skeleton = 150)
  // 像素 2: 核心骨线 (skeleton = 255)
  const W = 3, H = 1;
  const skeleton = new Uint8Array([30, 150, 255]);
  const pixels = new Uint8ClampedArray([
    20, 13, 7, 255,
    20, 13, 7, 255,
    20, 13, 7, 255,
  ]);

  // 1. 当 activeDissolve = 0.5 时（中度消融）
  applyMorphologicalDissolution(pixels, skeleton, W * H, 0.5, false);

  const a0 = pixels[0 * 4 + 3];
  const a1 = pixels[1 * 4 + 3];
  const a2 = pixels[2 * 4 + 3];

  // 边缘像素 (skeleton=30) 应该比中轴核心像素 (skeleton=255) 更早消融/更透明
  assert.ok(a0 < a2, `边缘 alpha (${a0}) 必须低于中轴 alpha (${a2})，呈现形态学轮廓收缩`);

  // 颜色必须发生双色相渐变：向水痕浅茶褐色褪色 (R 通道从饱满的 20 上浮向 65)
  assert.ok(pixels[0 * 4] > 20, '消融过程中墨色向浅茶褐水痕褪色，杜绝单色贴片淡化');
});


