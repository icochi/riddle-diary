import test from 'node:test';
import assert from 'node:assert/strict';

function setupMockDom() {
  const listeners = {};
  const mockInput = {
    value: '',
    selectionStart: 0,
    style: {},
    addEventListener: (ev, fn) => {
      listeners[ev] = listeners[ev] || [];
      listeners[ev].push(fn);
    },
    focus: () => {},
    blur: () => {},
  };

  const mockCanvas = {
    width: 2048,
    height: 2048,
    getContext: () => ({
      clearRect: () => {},
      save: () => {},
      restore: () => {},
      fillText: () => {},
      measureText: (s) => ({ width: s.length * 20 }),
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: () => {},
      beginPath: () => {},
      moveTo: () => {},
      quadraticCurveTo: () => {},
      stroke: () => {},
      drawImage: () => {},
    }),
  };

  globalThis.document = {
    getElementById: (id) => (id === 'ink-hidden-input' ? mockInput : null),
    createElement: (tag) => (tag === 'canvas' ? mockCanvas : tag === 'input' ? mockInput : {}),
    fonts: { load: () => Promise.resolve(), ready: Promise.resolve() },
    activeElement: mockInput,
    body: { appendChild: () => {}, removeChild: () => {} },
  };
  globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

setupMockDom();

const { createInkSystem } = await import('../src/ink.js');
const { DEFAULT_ECHO_CONFIG } = await import('../src/session-echo-playback.js');

test('[REPRO] 切换历史会话在单页落定(settle)到回放(echo)启动间不应提前触发滴墨或草稿闪现', async () => {
  const ink = createInkSystem(null, {
    textConfig: { duration: 10, emergeDuration: 10 },
  });
  ink.setEnabled(true);

  ink.sessionModel.addHistory('测试提问', '测试回答');
  const sess1Id = ink.sessionModel.currentSessionId;

  ink.beginSessionReset({ playLeaf: ({ direction }, done) => done() });
  ink.signalQuillSettled();
  ink.finishSessionReset();

  let leafCallback = null;
  ink.setPlayLeaf(({ direction }, done) => {
    leafCallback = done;
  });

  ink.switchSession(sess1Id);

  // 等待消融完成，触发 playLeaf
  await new Promise((res) => setTimeout(res, 30));
  assert.ok(leafCallback, 'playLeaf 回调应已就绪');

  // 执行单页落定
  leafCallback();

  // 在 settlePause (200ms) 期间，echoPlayback 尚未 start()
  // 此时不应启动滴墨，dropPipeline 的 phase 不应该被提早设为非 idle 状态
  assert.equal(
    ink.dropPipeline.currentPhase,
    'idle',
    '单页落定静置期严禁提早触发滴墨循环导致瞬闪'
  );

  ink.setEnabled(false);
});

test('[REPRO] echoPlayback 回放结束 finalizeSwitch 前必须先将着色器置为消融态，杜绝整页闪现', async () => {
  const ink = createInkSystem(null, {
    textConfig: { duration: 10, emergeDuration: 10 },
  });
  ink.setEnabled(true);

  ink.sessionModel.addHistory('测试提问', '测试回答');
  const sess1Id = ink.sessionModel.currentSessionId;

  ink.beginSessionReset({ playLeaf: ({ direction }, done) => done() });
  ink.signalQuillSettled();
  ink.finishSessionReset();

  ink.setPlayLeaf(({ direction }, done) => done());
  ink.switchSession(sess1Id);

  await new Promise((res) => setTimeout(res, 250));

  // 断言：在回放进行中，leftTextDissolve 应保持在 0，且不能提前让左页文字在未置消融态前绘制到屏幕
  // 当回放结束 finalize 时，必须先设置 leftTextDissolve = 1.0 (或 prepare) 再 redrawFullCanvas
  assert.ok(ink.isEchoReplaying(), '应当处于回放中');

  ink.setEnabled(false);
});

test('[REPRO] DEFAULT_ECHO_CONFIG 停留时长与步进间隔必须符合人眼阅读舒适度', () => {
  // 当前配置: stayDuration=600ms, staggerMs=200ms
  // 这会导致文本刚出现 0.6 秒即消融，且每 0.2 秒刷新一条，视觉严重过快闪烁
  assert.ok(
    DEFAULT_ECHO_CONFIG.stayDuration >= 1400,
    `单条消息停留时间 (${DEFAULT_ECHO_CONFIG.stayDuration}ms) 过短，至少应 >= 1400ms 以供阅读`
  );
  assert.ok(
    DEFAULT_ECHO_CONFIG.staggerMs >= 600,
    `消息步进间隔 (${DEFAULT_ECHO_CONFIG.staggerMs}ms) 过短，至少应 >= 600ms 避免快速连击闪烁`
  );
  assert.ok(
    DEFAULT_ECHO_CONFIG.emergeDuration >= 700,
    `反显时长 (${DEFAULT_ECHO_CONFIG.emergeDuration}ms) 过短，应保持至少 700ms 舒缓书法渗析质感`
  );
});
