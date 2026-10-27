import test from 'node:test';
import assert from 'node:assert/strict';
import { InkInputCoordinator } from '../src/ink-input-coordinator.js';

function createMockSessionModel(pages = ['Hello']) {
  let buffer = '';
  let pageIndex = 0;

  return {
    get inputBuffer() { return buffer; },
    get displayedPageIndex() { return pageIndex; },
    get currentPrompt() { return buffer.trim(); },
    getCurrentPageInfo() {
      return { text: buffer, pageIndex };
    },
    setInput(text, cursor) {
      buffer = text;
      if (text === 'overflow-page') {
        return { action: 'forward', targetPageIndex: 1, ranges: [{ text: 'page1' }, { text: 'page2' }], currentText: 'page2' };
      }
      if (text === 'back-page') {
        return { action: 'backward', targetPageIndex: 0, ranges: [{ text: 'page1' }], currentText: 'page1' };
      }
      return { action: 'same', targetPageIndex: 0, ranges: [{ text }], currentText: text };
    },
    confirmForwardPage(idx) {
      pageIndex = idx;
    },
  };
}

test('InkInputCoordinator locks input when external is busy or page is transitioning', () => {
  let externalBusy = false;
  const sessionModel = createMockSessionModel();
  const coordinator = new InkInputCoordinator({
    sessionModel,
    config: { typingIdleDelay: 600, firstDropDelay: 1200, duration: 2000, emergeDuration: 2000 },
    isExternalBusy: () => externalBusy,
    displayPort: {
      setRenderText: () => {},
      redrawFullCanvas: () => {},
      animateTextErosion: () => () => {},
      animateTextEmergence: () => () => {},
    },
    dropPort: {
      stop: () => {},
      start: () => {},
    },
  });

  assert.equal(coordinator.isLocked, false);
  externalBusy = true;
  assert.equal(coordinator.isLocked, true);
  externalBusy = false;
  assert.equal(coordinator.isLocked, false);
});

test('InkInputCoordinator composition lifecycle preserves drop during composing and restarts on end', () => {
  const sessionModel = createMockSessionModel();
  let dropStarted = 0;
  let dropStopped = 0;
  let textRendered = '';
  let typedNotified = 0;

  const coordinator = new InkInputCoordinator({
    sessionModel,
    config: { typingIdleDelay: 600, firstDropDelay: 1200, duration: 2000, emergeDuration: 2000 },
    displayPort: {
      setRenderText: (txt) => { textRendered = txt; },
      redrawFullCanvas: () => {},
      animateTextErosion: () => () => {},
      animateTextEmergence: () => () => {},
    },
    dropPort: {
      stop: () => { dropStopped += 1; },
      start: (delay) => { dropStarted += 1; },
    },
    inputPort: {
      onType: () => { typedNotified += 1; },
    },
  });

  // 1. compositionstart: 保持墨滴可见不中断
  coordinator.handleCompositionStart();
  assert.equal(coordinator.isComposing, true);
  assert.equal(dropStopped, 0);

  // 2. compositionupdate: 不中断墨滴且不上屏草稿
  coordinator.handleCompositionUpdate();
  assert.equal(dropStopped, 0);
  assert.equal(textRendered, '');

  // 3. compositionend: 提交文字并重启滴墨
  coordinator.handleCompositionEnd('你好世界');
  assert.equal(coordinator.isComposing, false);
  assert.equal(textRendered, '你好世界');
  assert.equal(typedNotified, 1);
  assert.ok(dropStopped >= 1);
  assert.ok(dropStarted >= 1);
});

test('InkInputCoordinator forward transition triggers erosion then emergence in sequence', () => {
  const sessionModel = createMockSessionModel();
  let erosionDone = null;
  let emergenceDone = null;

  const coordinator = new InkInputCoordinator({
    sessionModel,
    config: { typingIdleDelay: 600, firstDropDelay: 1200, duration: 2000, emergeDuration: 2000 },
    displayPort: {
      setRenderText: () => {},
      redrawFullCanvas: () => {},
      animateTextErosion: (dur, done) => {
        erosionDone = done;
        return () => {};
      },
      animateTextEmergence: (dur, done) => {
        emergenceDone = done;
        return () => {};
      },
    },
    dropPort: {
      stop: () => {},
      start: () => {},
    },
  });

  coordinator.renderCurrentPage(false, 'overflow-page');

  // 阶段 1: 正在消融旧屏，被锁住
  assert.equal(coordinator.isTransitioningPage, true);
  assert.equal(coordinator.isLocked, true);
  assert.ok(erosionDone !== null);

  // 模拟消融结束，确认翻页并进入阶段 2 显影
  erosionDone();
  assert.equal(sessionModel.displayedPageIndex, 1);
  assert.equal(coordinator.isEmergingBackPage, true);
  assert.equal(coordinator.isLocked, true);
  assert.ok(emergenceDone !== null);

  // 模拟显影结束，完全解锁
  emergenceDone();
  assert.equal(coordinator.isEmergingBackPage, false);
  assert.equal(coordinator.isTransitioningPage, false);
  assert.equal(coordinator.isLocked, false);
});
