import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { QuillSurfaceTargeter } from '../src/quill-surface-targeter.js';

test('QuillSurfaceTargeter projects NDC (0,0) to paper plane at correct paperY', () => {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 3, 0.001);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  const targeter = new QuillSurfaceTargeter({
    camera,
    paperY: 0.15,
  });

  const { targetPos, isOverBook } = targeter.resolve(new THREE.Vector2(0, 0));
  assert.equal(isOverBook, false);
  assert.ok(Math.abs(targetPos.y - 0.15) < 1e-4);
  assert.ok(Math.abs(targetPos.x) < 1e-3);
});

test('QuillSurfaceTargeter offsets 1.5mm along ray when hitting book mesh to prevent z-fighting', () => {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 3, 0.001);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  const geo = new THREE.BoxGeometry(1, 0.1, 1);
  const mat = new THREE.MeshBasicMaterial();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(0, 0.12, 0);
  mesh.updateMatrixWorld();

  const targeter = new QuillSurfaceTargeter({
    camera,
    bookMeshes: [mesh],
    paperY: 0.12,
  });

  targeter.setNdc(0, 0);
  const { targetPos, isOverBook } = targeter.update();

  assert.equal(isOverBook, true);
  // Mesh 顶面在 y = 0.12 + 0.05 = 0.17。由于相机在 (0, 3, 0)，射线方向近似 (0, -1, 0)
  // 反向微浮 -0.0015 * (-1) 会使 targetPos.y > 0.17
  assert.ok(targetPos.y > 0.17, `targetPos.y (${targetPos.y}) should float above 0.17`);
});

test('QuillSurfaceTargeter clamps targets outside safety bounds on desktop plane', () => {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 5, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  const targeter = new QuillSurfaceTargeter({
    camera,
    paperY: 0.12,
    bounds: { minX: -1.5, maxX: 1.5, minZ: -1.0, maxZ: 1.0 },
  });

  // 极大 NDC 偏移
  targeter.setNdc(0.99, 0.99);
  const { targetPos } = targeter.update();

  assert.ok(targetPos.x <= 1.5 && targetPos.x >= -1.5);
  assert.ok(targetPos.z <= 1.0 && targetPos.z >= -1.0);
  assert.equal(targetPos.y, 0.12);
});

test('QuillSurfaceTargeter respects freeze flag during update()', () => {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 3, 0.001);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  const targeter = new QuillSurfaceTargeter({
    camera,
    paperY: 0.12,
  });

  targeter.setNdc(0, 0);
  targeter.update(false);
  const initialPos = targeter.targetPos.clone();

  // 修改 NDC 但设置 freeze = true
  targeter.setNdc(0.8, -0.8);
  targeter.update(true);

  assert.equal(targeter.targetPos.x, initialPos.x);
  assert.equal(targeter.targetPos.z, initialPos.z);
});

test('QuillSurfaceTargeter reuses cached result when mouseNdc does not change', () => {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 3, 0.001);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  const targeter = new QuillSurfaceTargeter({
    camera,
    paperY: 0.12,
  });

  targeter.setNdc(0.2, 0.3);
  let resolveCalls = 0;
  const originalResolve = targeter.resolve.bind(targeter);
  targeter.resolve = (ndc) => {
    resolveCalls++;
    return originalResolve(ndc);
  };

  targeter.update(false);
  assert.equal(resolveCalls, 1);

  // 未改动 mouseNdc 再次 update，应直接复用缓存，不重复执行 resolve
  targeter.update(false);
  assert.equal(resolveCalls, 1);

  // 改动 mouseNdc 后再次 update，应触发新的 resolve
  targeter.setNdc(0.5, 0.6);
  targeter.update(false);
  assert.equal(resolveCalls, 2);
});
