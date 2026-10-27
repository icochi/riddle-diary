import test from 'node:test';
import assert from 'node:assert';
import { QuillBottleSequence } from '../src/quill-bottle-sequence.js';

test('QuillBottleSequence traps within trapRadiusIn and releases beyond trapRadiusOut', () => {
  const seq = new QuillBottleSequence({
    trapRadiusIn: 0.24,
    trapRadiusOut: 0.38,
  });

  // 1. 远离瓶口 (0.50m)
  let state = seq.update({ dt: 0.016, distToLip: 0.50, isOverBook: false, canTrap: true });
  assert.equal(state.isTrapped, false);

  // 2. 移入进入半径内 (0.20m < 0.24m) -> 进入捕获
  state = seq.update({ dt: 0.016, distToLip: 0.20, isOverBook: false, canTrap: true });
  assert.equal(state.isTrapped, true);

  // 3. 在死区内略微外移 (0.30m，介于 0.24 与 0.38 之间) -> 保持捕获 (防抖滞后)
  state = seq.update({ dt: 0.016, distToLip: 0.30, isOverBook: false, canTrap: true });
  assert.equal(state.isTrapped, true);

  // 4. 彻底脱出 (0.40m > 0.38m) -> 解除捕获
  state = seq.update({ dt: 0.016, distToLip: 0.40, isOverBook: false, canTrap: true });
  assert.equal(state.isTrapped, false);
});

test('QuillBottleSequence rejects trap when over book or cannot trap', () => {
  const seq = new QuillBottleSequence();

  // 虽然距离很近，但处于书本上方
  let state = seq.update({ dt: 0.016, distToLip: 0.10, isOverBook: true, canTrap: true });
  assert.equal(state.isTrapped, false);

  // 未展开 / 合书态 (canTrap = false)
  state = seq.update({ dt: 0.016, distToLip: 0.10, isOverBook: false, canTrap: false });
  assert.equal(state.isTrapped, false);
});

test('QuillBottleSequence plays rapid double-dip and triggers completion callback', () => {
  const seq = new QuillBottleSequence({
    dipDuration: 0.70,
    dipDepth: 0.185,
  });

  let completed = false;
  seq.triggerDoubleDip(() => {
    completed = true;
  });

  assert.equal(seq.isTrapped, true);
  assert.equal(seq.isDipping, true);

  // 第一下潜峰值附近 (~0.15s)
  let state = seq.update({ dt: 0.15, distToLip: 0.0, isOverBook: false, canTrap: true });
  assert.ok(state.dipOffset > 0.15, `Dip 1 offset should plunge deeply, got ${state.dipOffset}`);

  // 推进至 0.70s 完成
  state = seq.update({ dt: 0.56, distToLip: 0.0, isOverBook: false, canTrap: true });
  assert.equal(state.isDipping, false);
  assert.equal(state.isTrapped, true, 'Should remain trapped on lip after dipping');
  assert.equal(completed, true, 'onComplete callback must be fired');
});
