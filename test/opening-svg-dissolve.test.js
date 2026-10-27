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

  let lastCleared = null;
  let putImageDataCalls = [];

  const mockCtx = {
    clearRect: (x, y, w, h) => {
      lastCleared = { x, y, w, h, time: Date.now() };
    },
    save: () => {},
    restore: () => {},
    fillText: () => {},
    measureText: (s) => ({ width: s.length * 20 }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (imgData, x, y) => {
      putImageDataCalls.push({ imgData, x, y, time: Date.now() });
    },
    drawImage: () => {},
    beginPath: () => {},
    moveTo: () => {},
    quadraticCurveTo: () => {},
    stroke: () => {},
  };

  const mockCanvas = {
    width: 2048,
    height: 2048,
    getContext: () => mockCtx,
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
  globalThis.Image = class {
    constructor() {
      setTimeout(() => {
        this.naturalWidth = 1865;
        this.naturalHeight = 576;
        if (this.onload) this.onload();
      }, 5);
    }
  };

  return { mockCtx, getPutCalls: () => putImageDataCalls, getLastCleared: () => lastCleared };
}

const { mockCtx, getPutCalls } = setupMockDom();
const { createInkSystem } = await import('../src/ink.js');

test('[REPRO] playOpeningSvgDissolve 期间右页题跋墨迹不应在 0ms 瞬间被 onRightPageRedraw 冲刷擦除', async () => {
  const ink = createInkSystem(null, {
    textConfig: { duration: 200, emergeDuration: 100 },
  });
  ink.setEnabled(true);

  let hasPutSvg = false;
  let clearCallsAfterPutSvg = 0;
  const originalPutImageData = mockCtx.putImageData;
  mockCtx.putImageData = (imgData, x, y) => {
    if (x > 500) {
      hasPutSvg = true;
    }
    originalPutImageData(imgData, x, y);
  };

  const originalClearRect = mockCtx.clearRect;
  mockCtx.clearRect = (x, y, w, h) => {
    // 检测是否落在右页区域，且在 SVG 贴图之后、消融结束之前
    if (x > 500 && hasPutSvg && ink.isPlayingOpeningSvg()) {
      clearCallsAfterPutSvg++;
    }
    originalClearRect(x, y, w, h);
  };

  // 触发开场题跋动画
  await new Promise((resolve) => {
    ink.playOpeningSvgDissolve({
      emergeDuration: 50,
      stayDuration: 50,
      dissolveDuration: 50,
      onComplete: resolve,
    });
  });

  // 在正常设计中，题跋墨迹贴上后，动画演播期间墨迹必须保持在右页，绝不能被 clearRect 冲刷抹除
  assert.equal(hasPutSvg, true, '题跋墨迹必须成功写入右页 Canvas');
  assert.equal(
    clearCallsAfterPutSvg,
    0,
    `在开场题跋演播期间发生 ${clearCallsAfterPutSvg} 次右页擦除，题跋被提前冲刷清空`
  );
  assert.equal(ink.isPlayingOpeningSvg(), false, '消融结束后状态恢复为非演播态');
  ink.setEnabled(false);
});

test('在题跋消融演播期间连续调用 setEnabled(true) 与窗口重绘不会冲掉题跋', async () => {
  const ink = createInkSystem(null, {
    textConfig: { duration: 200, emergeDuration: 100 },
  });
  ink.setEnabled(true);

  let hasPutSvg = false;
  let clearCallsAfterPutSvg = 0;
  mockCtx.putImageData = (imgData, x, y) => {
    if (x > 500) hasPutSvg = true;
  };
  mockCtx.clearRect = (x, y, w, h) => {
    if (x > 500 && hasPutSvg && ink.isPlayingOpeningSvg()) {
      clearCallsAfterPutSvg++;
    }
  };

  const playPromise = new Promise((resolve) => {
    ink.playOpeningSvgDissolve({
      emergeDuration: 80,
      stayDuration: 80,
      dissolveDuration: 80,
      onComplete: resolve,
    });
  });

  // 模拟翻开日记时每一帧的 setEnabled(true) 触发
  for (let i = 0; i < 5; i++) {
    ink.setEnabled(true);
  }

  await playPromise;
  assert.equal(hasPutSvg, true);
  assert.equal(clearCallsAfterPutSvg, 0, '连续调用 setEnabled 不得擦除右页正在演播的题跋');
  ink.setEnabled(false);
});

test('在题跋演播期间输入字符可立即打断题跋并让渡给打字逻辑', async () => {
  const ink = createInkSystem(null, {
    textConfig: { duration: 200, emergeDuration: 100 },
  });
  ink.setEnabled(true);

  let completed = false;
  ink.playOpeningSvgDissolve({
    emergeDuration: 200,
    stayDuration: 200,
    dissolveDuration: 200,
    onComplete: () => {
      completed = true;
    },
  });

  assert.equal(ink.isPlayingOpeningSvg(), true);
  ink.cancelOpeningSvgDissolve();
  assert.equal(ink.isPlayingOpeningSvg(), false, '打断后应立即退出题跋演播态');
  assert.equal(completed, false, '打断时不应触发正常完成回调');
  ink.setEnabled(false);
});
