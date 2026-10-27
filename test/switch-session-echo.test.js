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
      drawImage: () => {},
      beginPath: () => {},
      moveTo: () => {},
      quadraticCurveTo: () => {},
      stroke: () => {},
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

// 必须在 setupMockDom 后动态导入
const { createInkSystem } = await import('../src/ink.js');

test('switchSession 切换历史 Session 时触发双页流式回响演播并在结束后恢复常规状态', async () => {
  const ink = createInkSystem(null, {
    textConfig: { duration: 10, emergeDuration: 10 },
  });
  ink.setEnabled(true);

  // 1. Session 1 下写入两轮问答并留有一段草稿
  ink.sessionModel.addHistory('提问 1', '回答 1');
  ink.sessionModel.addHistory('提问 2', '回答 2');
  ink.sessionModel.setInput('Session 1 留存草稿');
  const session1Id = ink.sessionModel.currentSessionId;

  // 2. 创建 Session 2 并写入一轮问答
  ink.beginSessionReset({
    playLeaf: ({ direction }, done) => done(),
  });
  ink.signalQuillSettled();
  ink.finishSessionReset();

  const session2Id = ink.sessionModel.currentSessionId;
  assert.notEqual(session1Id, session2Id);
  ink.sessionModel.addHistory('Session 2 提问', 'Session 2 回答');

  // 3. 切换回 Session 1
  let leafPlayed = false;
  let leafDirection = null;
  ink.setPlayLeaf(({ direction }, done) => {
    leafPlayed = true;
    leafDirection = direction;
    done();
  });

  ink.switchSession(session1Id);

  // 等待消融与翻页回调触发
  await new Promise((res) => setTimeout(res, 350));

  assert.equal(leafPlayed, true);
  assert.equal(leafDirection, 'backward', '切回历史 Session 使用 backward 翻页');

  // 此时应当已经启动 echoPlayback
  assert.equal(ink.isEchoReplaying(), true, '进入流式回响状态');
  assert.equal(ink.sessionModel.currentSessionId, session1Id);

  // 测试通过 interrupt() 打断演播
  ink.echoPlayback.interrupt();

  assert.equal(ink.isEchoReplaying(), false, '演播被即时打断并收束');
  assert.equal(ink.sessionModel.inputBuffer, 'Session 1 留存草稿', '无损恢复了 Session 1 的草稿');

  // 验证左页常规 Session 列表已重绘，且 session1 处于当前活跃状态
  const leftItems = ink.sessionModel.getFlattenedIndexItems();
  assert.equal(leftItems.length, 2);
  const currentItem = leftItems.find((item) => item.id === session1Id);
  assert.ok(currentItem);
  assert.equal(currentItem.isCurrent, true);

  ink.setEnabled(false);
});
