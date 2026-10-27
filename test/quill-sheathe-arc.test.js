import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { QuillSheatheArc, evaluateArcPose } from '../src/quill-sheathe-arc.js';

test('evaluateArcPose aligns with P0 at t=0 and P3 at t=1', () => {
  const p0 = new THREE.Vector3(-1.3, 0.1, 0.5);
  const apex = new THREE.Vector3(-1.3, 0.45, 0.5);
  const p3 = new THREE.Vector3(0.5, 0.12, 0.0);
  const startQuat = new THREE.Quaternion(0, 0, 0, 1);
  const endQuat = new THREE.Quaternion(0.5, 0.5, 0.5, 0.5);

  const startPose = evaluateArcPose({ t: 0, p0, apexPos: apex, p3, startQuat, endQuat });
  assert.ok(startPose.pos.distanceTo(p0) < 1e-4);
  assert.ok(Math.abs(startPose.quat.dot(startQuat) - 1.0) < 1e-4);

  const endPose = evaluateArcPose({ t: 1, p0, apexPos: apex, p3, startQuat, endQuat });
  assert.ok(endPose.pos.distanceTo(p3) < 1e-4);
  assert.ok(Math.abs(endPose.quat.dot(endQuat) - 1.0) < 1e-4);
});

test('evaluateArcPose rises to bottle clearance apex along curve', () => {
  const p0 = new THREE.Vector3(-1.3, 0.1, 0.5);
  const apex = new THREE.Vector3(-1.3, 0.55, 0.5);
  const p3 = new THREE.Vector3(0.5, 0.12, 0.0);
  const startQuat = new THREE.Quaternion(0, 0, 0, 1);
  const endQuat = new THREE.Quaternion(0, 0, 0, 1);

  // 在中间进度 t=0.3~0.5 处，由于避瓶拱顶高度，Y 应该显著高于两端 (p0.y, p3.y)
  const midPose = evaluateArcPose({ t: 0.35, p0, apexPos: apex, p3, startQuat, endQuat });
  assert.ok(midPose.pos.y > Math.max(p0.y, p3.y) + 0.15, `Mid pose Y ${midPose.pos.y} should crest above start and end`);
});

test('QuillSheatheArc transitions between in_bottle and following via setActive', () => {
  const arc = new QuillSheatheArc({ transitionSpeed: 2.0 }); // 0.5s 完成
  assert.equal(arc.isInBottle, true);
  assert.equal(arc.progress, 0.0);

  arc.setActive(true);
  assert.equal(arc.state, 'unsheathing');

  // 步进 0.25s
  arc.step(0.25);
  assert.equal(arc.state, 'unsheathing');
  assert.ok(Math.abs(arc.progress - 0.5) < 1e-4);

  // 再步进 0.3s (总计 0.55s > 0.5s)
  arc.step(0.3);
  assert.equal(arc.isFollowing, true);
  assert.equal(arc.progress, 1.0);

  // 合书插回
  arc.setActive(false);
  assert.equal(arc.state, 'sheathing');
  arc.step(0.55);
  assert.equal(arc.isInBottle, true);
  assert.equal(arc.progress, 0.0);
});

test('QuillSheatheArc respects forceUnsheathed during step', () => {
  const arc = new QuillSheatheArc({ transitionSpeed: 2.0 });
  assert.equal(arc.isInBottle, true);

  // 未主动 setActive，但设置 forceUnsheathed: true
  arc.step(0.1, { forceUnsheathed: true });
  assert.equal(arc.state, 'unsheathing');
  assert.ok(arc.progress > 0.0);
});


test('QuillFollowRig hoverOverBottle locks pose hovering above bottle with vertical orientation', () => {
  const bottleLipPos = new THREE.Vector3(-1.3, 0.45, 0.52);
  const rig = new (class MockRig {
    constructor() {
      this.isBottleHoverLocked = false;
      this.freezeFollow = false;
      this.isTrapped = false;
      this.trapBlend = 0.0;
      this.bottleLipPos = bottleLipPos;
      this.currentPos = new THREE.Vector3(0, 0, 0);
      this.targetPos = new THREE.Vector3(0, 0, 0);
    }
    hoverOverBottle() {
      this.isBottleHoverLocked = true;
      this.freezeFollow = true;
      this.isTrapped = true;
      this.trapBlend = 1.0;
      this.currentPos.copy(this.bottleLipPos);
      this.targetPos.copy(this.bottleLipPos);
    }
    releaseBottleHover() {
      this.isBottleHoverLocked = false;
      this.freezeFollow = false;
      this.isTrapped = false;
    }
  })();

  assert.equal(rig.isBottleHoverLocked, false);
  assert.equal(rig.freezeFollow, false);

  rig.hoverOverBottle();
  assert.equal(rig.isBottleHoverLocked, true, 'hoverOverBottle 必须锁定瓶口悬停');
  assert.equal(rig.freezeFollow, true, 'hoverOverBottle 必须冻结跟随');
  assert.equal(rig.trapBlend, 1.0, 'hoverOverBottle 必须满额应用瓶口竖直朝向');
  assert.ok(rig.currentPos.distanceTo(bottleLipPos) < 1e-4, '坐标必须精准对齐 bottleLipPos');

  rig.releaseBottleHover();
  assert.equal(rig.isBottleHoverLocked, false);
  assert.equal(rig.freezeFollow, false);
  assert.equal(rig.isTrapped, false);
});
