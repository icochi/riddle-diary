import test from 'node:test';
import assert from 'node:assert/strict';
import { InkDissolveDriver } from '../src/ink-dissolve-driver.js';

function createMockClock() {
  let currentTime = 0;
  let nextHandle = 1;
  const scheduled = new Map();

  return {
    now: () => currentTime,
    requestFrame: (fn) => {
      const handle = nextHandle++;
      scheduled.set(handle, fn);
      return handle;
    },
    cancelFrame: (handle) => {
      scheduled.delete(handle);
    },
    tick: (ms) => {
      currentTime += ms;
      const callbacks = [...scheduled.values()];
      scheduled.clear();
      for (const cb of callbacks) {
        cb(currentTime);
      }
    },
  };
}

test('InkDissolveDriver initializes default uniforms with safe initial values', () => {
  const driver = new InkDissolveDriver();
  assert.equal(driver.textDissolve.value, 0.0);
  assert.equal(driver.leftTextDissolve.value, 0.0);
  assert.equal(driver.leftEmergingYRange.value.x, -1.0);
  assert.equal(driver.leftEmergingYRange.value.y, -1.0);
  assert.equal(driver.isRightBusy, false);
  assert.equal(driver.isLeftBusy, false);
});

test('InkDissolveDriver dissolveRight drives textDissolve with quadratic easing', () => {
  const clock = createMockClock();
  let redrawCalled = false;
  let completed = false;

  const driver = new InkDissolveDriver({
    clock,
    renderPort: {
      onRightPageRedraw: () => { redrawCalled = true; },
    },
  });

  driver.dissolveRight(1000, () => {
    completed = true;
  });

  assert.equal(driver.isRightBusy, true);
  assert.equal(driver.textDissolve.value, 0.0);

  // 50% 时间：0.5^2 = 0.25
  clock.tick(500);
  assert.ok(Math.abs(driver.textDissolve.value - 0.25) < 0.01);
  assert.equal(completed, false);

  // 100% 时间：1.0 完成，复位并触发重绘
  clock.tick(500);
  assert.equal(completed, true);
  assert.equal(driver.textDissolve.value, 0.0);
  assert.equal(redrawCalled, true);
  assert.equal(driver.isRightBusy, false);
});

test('InkDissolveDriver emergeRight pre-sets textDissolve to 1.0 and fades in', () => {
  const clock = createMockClock();
  let redrawCount = 0;
  let completed = false;

  const driver = new InkDissolveDriver({
    clock,
    renderPort: {
      onRightPageRedraw: () => { redrawCount += 1; },
    },
  });

  driver.emergeRight(1000, () => {
    completed = true;
  });

  // 显影前应先触发一次静态重绘并将 uniform 设为 1.0 (完全消融态)
  assert.equal(redrawCount, 1);
  assert.equal(driver.textDissolve.value, 1.0);
  assert.equal(driver.isRightBusy, true);

  // 50% 时间：ease = 1 - (1 - 0.5)^2 = 0.75, uniform = 1.0 - 0.75 = 0.25
  clock.tick(500);
  assert.ok(Math.abs(driver.textDissolve.value - 0.25) < 0.01);
  assert.equal(completed, false);

  // 完成后归零
  clock.tick(500);
  assert.equal(completed, true);
  assert.equal(driver.textDissolve.value, 0.0);
  assert.equal(driver.isRightBusy, false);
});

test('InkDissolveDriver cancelRight cancels active animation and resets state', () => {
  const clock = createMockClock();
  let redrawCount = 0;
  let completed = false;

  const driver = new InkDissolveDriver({
    clock,
    renderPort: {
      onRightPageRedraw: () => { redrawCount += 1; },
    },
  });

  const cancel = driver.dissolveRight(1000, () => { completed = true; });
  clock.tick(300);
  assert.ok(driver.textDissolve.value > 0);

  cancel();
  assert.equal(driver.textDissolve.value, 0.0);
  assert.equal(driver.isRightBusy, false);
  assert.equal(completed, false);

  // 之后再 tick 不触发完成
  clock.tick(700);
  assert.equal(completed, false);
});

test('InkDissolveDriver prepareLeftItem and emergeLeftItem constrain Y range without leak', () => {
  const clock = createMockClock();
  let completed = false;

  const driver = new InkDissolveDriver({ clock });
  const bound = { yMinNorm: 0.25, yMaxNorm: 0.35 };

  driver.prepareLeftItem(bound);
  assert.equal(driver.leftTextDissolve.value, 1.0);
  assert.equal(driver.leftEmergingYRange.value.x, 0.25);
  assert.equal(driver.leftEmergingYRange.value.y, 0.35);

  driver.emergeLeftItem(bound, 1000, () => { completed = true; });
  assert.equal(driver.isLeftBusy, true);

  clock.tick(500);
  assert.ok(driver.leftTextDissolve.value > 0 && driver.leftTextDissolve.value < 1);

  clock.tick(500);
  assert.equal(completed, true);
  assert.equal(driver.leftTextDissolve.value, 0.0);
  assert.equal(driver.leftEmergingYRange.value.x, -1.0);
  assert.equal(driver.leftEmergingYRange.value.y, -1.0);
  assert.equal(driver.isLeftBusy, false);
});

test('InkDissolveDriver dissolveBothPages arbitrates full mutual exclusion', () => {
  const clock = createMockClock();
  let rightCompleted = false;
  let fullCompleted = false;

  const driver = new InkDissolveDriver({ clock });

  // 先开一个右页动画
  driver.dissolveRight(1000, () => { rightCompleted = true; });
  assert.equal(driver.isRightBusy, true);

  // 换页复显触发双页吸干，必须抢占并强行打断右页动画
  driver.dissolveBothPages(800, () => { fullCompleted = true; });
  assert.equal(driver.isFullBusy, true);
  assert.equal(rightCompleted, false);

  clock.tick(400);
  assert.ok(driver.textDissolve.value > 0);
  assert.ok(driver.leftTextDissolve.value > 0);

  clock.tick(400);
  assert.equal(fullCompleted, true);
  assert.equal(driver.textDissolve.value, 0.0);
  assert.equal(driver.leftTextDissolve.value, 1.0); // 左页保持消融态等待后续整页复显
  assert.equal(driver.isFullBusy, false);
});

test('InkDissolveDriver cancelAll clears all channels cleanly', () => {
  const clock = createMockClock();
  const driver = new InkDissolveDriver({ clock });

  driver.dissolveRight(1000);
  driver.emergeLeftItem({ yMinNorm: 0.1, yMaxNorm: 0.2 }, 1000);

  assert.equal(driver.isRightBusy, true);
  assert.equal(driver.isLeftBusy, true);

  driver.cancelAll();
  assert.equal(driver.isRightBusy, false);
  assert.equal(driver.isLeftBusy, false);
  assert.equal(driver.textDissolve.value, 0.0);
  assert.equal(driver.leftTextDissolve.value, 0.0);
  assert.equal(driver.leftEmergingYRange.value.x, -1.0);
  assert.equal(driver.leftEmergingYRange.value.y, -1.0);
});
