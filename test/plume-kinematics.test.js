import test from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import { PlumeKinematics } from '../src/plume-kinematics.js';

test('PlumeKinematics resolves pitch elevation when plume dips below desk level', () => {
  // 羽毛模型在局部坐标系中沿 +Y 轴指向羽梢
  const localVertices = [
    new THREE.Vector3(0, 0, 0),         // 笔尖锚点 (原点)
    new THREE.Vector3(0, 0.15, 0),      // 羽身
    new THREE.Vector3(0, 0.30, 0),      // 羽梢
  ];

  const kinematics = new PlumeKinematics({
    localVertices,
    groundY: 0.0,
    bookBounds: { minX: -1, maxX: 1, minZ: -1, maxZ: 1, topY: 0.12, bottomY: 0.0 },
  });

  const basePos = new THREE.Vector3(1.2, 0.0, 1.2); // 桌面区域 (远离书本)
  // 真实的桌面姿态 (0.5, 0.5, 0.5, 0.5)：将 +Y 羽轴旋转至指向水平桌面侧面微下沉
  const baseQuat = new THREE.Quaternion(0.5, 0.5, 0.5, 0.5);

  // 单步解算 (充分时间步长使滤波就位)
  let result;
  for (let step = 0; step < 10; step++) {
    result = kinematics.solve({
      pos: basePos,
      quat: baseQuat,
      dt: 0.05,
      t: 1.0,
      isOverBook: false,
      trapBlend: 0.0,
    });
  }

  // 断言：由于羽梢原处于负高度，kinematics 必须驱动 pitchOffset > 0，使羽梢抬起
  assert.ok(kinematics.pitchOffset > 0, `pitchOffset must be positive, got ${kinematics.pitchOffset}`);
  assert.notDeepEqual(result.quat, baseQuat, 'Quaternion must be adjusted to tilt plume upwards');

  // 验证抬起后所有顶点在世界坐标系中的 Y 均不低于桌面安全高度
  for (const v of localVertices) {
    const worldV = v.clone().applyQuaternion(result.quat).add(result.pos);
    assert.ok(worldV.y >= -0.001, `Vertex Y should not penetrate ground, got ${worldV.y}`);
  }
});

test('PlumeKinematics locks fixed pose when hovering over book', () => {
  const localVertices = [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, -0.05, 0.15),
  ];

  const kinematics = new PlumeKinematics({
    localVertices,
    groundY: 0.0,
  });

  const basePos = new THREE.Vector3(0.3, 0.12, 0.0); // 笔记本上方
  const baseQuat = new THREE.Quaternion(0.32, 0.89, 0.20, 0.21);

  // 在书本上方解算
  const result = kinematics.solve({
    pos: basePos,
    quat: baseQuat,
    dt: 0.016,
    t: 1.0,
    isOverBook: true,
    trapBlend: 0.0,
  });

  // 书本上方锁定固定姿态，pitch 与 yaw 不产生额外避让偏转
  assert.equal(kinematics.pitchOffset, 0);
  assert.equal(kinematics.yawOffset, 0);
  assert.equal(result.quat.x, baseQuat.x);
  assert.equal(result.quat.y, baseQuat.y);
  assert.equal(result.quat.z, baseQuat.z);
  assert.equal(result.quat.w, baseQuat.w);
});
