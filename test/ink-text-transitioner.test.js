import test from 'node:test';
import assert from 'node:assert/strict';
import { InkTextTransitioner } from '../src/ink-text-transitioner.js';
import { LeftPageHistoryView } from '../src/left-page-history-view.js';
import { InkSessionModel } from '../src/ink-session.js';

function createMockDissolveDriver() {
  const calls = [];
  return {
    calls,
    textDissolve: { value: 0.0 },
    leftTextDissolve: { value: 0.0 },
    leftEmergingYRange: {
      value: {
        x: -1.0,
        y: -1.0,
        set(x, y) {
          this.x = x;
          this.y = y;
        },
      },
    },
    prepareLeftItem(bound) {
      calls.push({ fn: 'prepareLeftItem', bound });
      if (bound) {
        this.leftTextDissolve.value = 1.0;
        this.leftEmergingYRange.value.set(bound.yMinNorm, bound.yMaxNorm);
      }
    },
    emergeLeftItem(bound, duration, done) {
      calls.push({ fn: 'emergeLeftItem', bound, duration });
      this.leftTextDissolve.value = 0.0;
      if (done) done();
      return () => calls.push({ fn: 'cancelEmerge' });
    },
    dissolveLeftItem(bound, duration, done) {
      calls.push({ fn: 'dissolveLeftItem', bound, duration });
      this.leftTextDissolve.value = 1.0;
      if (done) done();
      return () => calls.push({ fn: 'cancelDissolve' });
    },
    dissolveLeftHistory(duration, done) {
      calls.push({ fn: 'dissolveLeftHistory', duration });
      this.leftTextDissolve.value = 1.0;
      this.leftEmergingYRange.value.set(-1.0, -1.0);
      if (done) done();
      return () => calls.push({ fn: 'cancelDissolveHistory' });
    },
    emergeLeftHistory(duration, done) {
      calls.push({ fn: 'emergeLeftHistory', duration });
      this.leftTextDissolve.value = 0.0;
      this.leftEmergingYRange.value.set(-1.0, -1.0);
      if (done) done();
      return () => calls.push({ fn: 'cancelEmergeHistory' });
    },
  };
}

test('InkTextTransitioner 三原语正确调度着色器与 Canvas 回调', () => {
  const driver = createMockDissolveDriver();
  let rendered = false;
  let cleared = false;
  const historyView = new LeftPageHistoryView({
    pageRect: { x: 100, y: 200, w: 400, h: 600 },
    fontConfig: { size: 30, lineHeight: 40, family: 'sans-serif' },
    canvasSize: 1000,
  });

  const transitioner = new InkTextTransitioner({
    dissolveDriver: driver,
    historyView,
    redrawFullCanvas: () => {},
  });

  // 1. 插入原语 (Insert)
  const bound = { yMinNorm: 0.2, yMaxNorm: 0.4 };
  transitioner.insertLeftText({
    boundInfo: bound,
    render: () => { rendered = true; },
    duration: 1000,
  });
  assert.equal(rendered, true);
  assert.equal(driver.calls[0].fn, 'prepareLeftItem');
  assert.equal(driver.calls[1].fn, 'emergeLeftItem');

  // 2. 更新原语 (Update)
  driver.calls.length = 0;
  transitioner.updateLeftText({
    dissolveBoundInfo: bound,
    dissolveDuration: 300,
    emergeDuration: 800,
    render: () => {},
  });
  assert.equal(driver.calls[0].fn, 'dissolveLeftItem');
  assert.equal(driver.calls[1].fn, 'prepareLeftItem');
  assert.equal(driver.calls[2].fn, 'emergeLeftItem');

  // 3. 删除原语 (Delete)
  driver.calls.length = 0;
  transitioner.deleteLeftText({
    boundInfo: bound,
    duration: 300,
    afterClear: () => { cleared = true; },
  });
  assert.equal(driver.calls[0].fn, 'dissolveLeftItem');
  assert.equal(cleared, true);
});

test('InkTextTransitioner 首问更名与新增条目合并 Y 范围消融显影调度', () => {
  const driver = createMockDissolveDriver();
  let redrawCount = 0;

  const sessionModel = new InkSessionModel({
    textMeasurer: (t) => [{ start: 0, end: t.length, text: t }],
    historyCapacity: 5,
  });

  const historyView = {
    getItemBounds(id) {
      if (id.startsWith('sess_')) return { yMinNorm: 0.1, yMaxNorm: 0.2 };
      if (id.startsWith('hist_')) return { yMinNorm: 0.2, yMaxNorm: 0.3 };
      return null;
    },
    getItemBoundsByIndex(idx) {
      if (idx === 0) return { yMinNorm: 0.1, yMaxNorm: 0.2 };
      return null;
    },
  };

  const transitioner = new InkTextTransitioner({
    dissolveDriver: driver,
    historyView,
    redrawFullCanvas: () => { redrawCount++; },
  });

  // 场景 1: 首个会话在没有任何历史条目时，首问提交不会引起下方条目位移（无其他项需下移）
  const cur = sessionModel.currentSession;
  assert.equal(cur.hasCustomTitle, false);
  transitioner.dissolveInitialTitleIfNeeded(sessionModel, 300);
  assert.equal(driver.calls.length, 0, '没有其他条目时无需消融左页');

  // 模拟首个会话提交历史并计算复合边界
  const histItem = sessionModel.addHistory('今天天气真好', '哈利，今天确实风和日丽。');
  const combined = transitioner.prepareHistoryAddition({
    sessionModel,
    histItem,
    isFirstQuestion: true,
  });

  assert.equal(redrawCount, 1);
  assert.ok(combined);
  // 合并后 Y 范围应覆盖标题行与历史项 [0.1, 0.3]
  assert.equal(combined.yMinNorm, 0.1);
  assert.equal(combined.yMaxNorm, 0.3);

  // 场景 2: 创建新 Session，此时左页已有前一个 Session 标题
  driver.calls.length = 0;
  const newSess = sessionModel.createSession();
  assert.equal(newSess.hasCustomTitle, false);
  // 此时新 Session 提交首问，由于下方已有旧 Session 会导致位移，必须触发整页消融
  transitioner.dissolveInitialTitleIfNeeded(sessionModel, 2400);
  assert.equal(driver.calls[0].fn, 'dissolveLeftHistory', '存在其他条目时首问触发左页整页消融');
  assert.equal(driver.calls[0].duration, 2400);

  // 模拟首问就绪，触发整页消融预备
  const hist2 = sessionModel.addHistory('新篇章首问', '回答');
  const fullPageResult = transitioner.prepareHistoryAddition({
    sessionModel,
    histItem: hist2,
    isFirstQuestion: true,
    isFullPage: true,
  });
  assert.equal(fullPageResult, null);
  assert.equal(driver.leftTextDissolve.value, 1.0);
});
