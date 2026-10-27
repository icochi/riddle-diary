import test from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import { SceneInteractionDispatcher } from '../src/scene-interaction-dispatcher.js';

function createMockCamera() {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 5, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

test('SceneInteractionDispatcher blocks clicks on invalid canvas rect', () => {
  const camera = createMockCamera();
  let bottleClicked = false;
  let outsideClicked = false;

  const dispatcher = new SceneInteractionDispatcher({
    camera,
    actions: {
      onBottleClick: () => { bottleClicked = true; },
      onOutsideClick: () => { outsideClicked = true; },
    },
  });

  const invalidRect = { left: 0, top: 0, width: 0, height: 0 };
  const res = dispatcher.dispatchClick(500, 500, invalidRect);
  assert.strictEqual(res, 'blocked');
  assert.strictEqual(bottleClicked, false);
  assert.strictEqual(outsideClicked, false);

  const validRect = { left: 0, top: 0, width: 1000, height: 1000 };
  const res2 = dispatcher.dispatchClick(500, 500, validRect);
  assert.strictEqual(res2, 'outside');
  assert.strictEqual(outsideClicked, true);
});

test('SceneInteractionDispatcher prioritizes bottle mesh hit over outside', () => {
  const camera = createMockCamera();
  // 在原点放置墨水瓶网格
  const geom = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshBasicMaterial();
  const bottleMesh = new THREE.Mesh(geom, mat);
  bottleMesh.position.set(0, 0, 0);
  bottleMesh.updateMatrixWorld();

  let bottleFired = false;
  let outsideFired = false;

  const dispatcher = new SceneInteractionDispatcher({
    camera,
    targets: {
      bottleObjects: [bottleMesh],
    },
    stateQuery: {
      isFullyOpen: () => true,
    },
    actions: {
      onBottleClick: () => { bottleFired = true; },
      onOutsideClick: () => { outsideFired = true; },
    },
  });

  const rect = { left: 0, top: 0, width: 1000, height: 1000 };
  // 点击正中心 (500, 500) -> 射线命中 (0, 0, 0) 处的墨水瓶
  const res = dispatcher.dispatchClick(500, 500, rect);
  assert.strictEqual(res, 'bottle');
  assert.strictEqual(bottleFired, true);
  assert.strictEqual(outsideFired, false);

  // 点击边缘 (50, 50) -> 未命中任何物体 -> outside
  bottleFired = false;
  const res2 = dispatcher.dispatchClick(50, 50, rect);
  assert.strictEqual(res2, 'outside');
  assert.strictEqual(bottleFired, false);
  assert.strictEqual(outsideFired, true);
});

test('SceneInteractionDispatcher triggers bottle via quill when quill is in bottle', () => {
  const camera = createMockCamera();
  const geom = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshBasicMaterial();
  const quillMesh = new THREE.Mesh(geom, mat);
  quillMesh.position.set(0, 0, 0);
  quillMesh.updateMatrixWorld();

  let bottleFired = false;
  let inBottle = false;

  const dispatcher = new SceneInteractionDispatcher({
    camera,
    targets: {
      quillObjects: [quillMesh],
    },
    stateQuery: {
      isFullyOpen: () => true,
      isQuillInBottle: () => inBottle,
    },
    actions: {
      onBottleClick: () => { bottleFired = true; },
    },
  });

  const rect = { left: 0, top: 0, width: 1000, height: 1000 };
  // 当 inBottle 为 false 时，点击羽毛笔不视作点击墨水瓶
  const res1 = dispatcher.dispatchClick(500, 500, rect);
  assert.strictEqual(res1, 'outside');
  assert.strictEqual(bottleFired, false);

  // 当 inBottle 为 true 时，点击羽毛笔满足 ADR-0011 条件二，视作点击墨水瓶
  inBottle = true;
  const res2 = dispatcher.dispatchClick(500, 500, rect);
  assert.strictEqual(res2, 'bottle');
  assert.strictEqual(bottleFired, true);
});

test('SceneInteractionDispatcher suppresses trapped hover bottle check when session resetting', () => {
  const camera = createMockCamera();
  let bottleFired = false;
  let isHovering = true;
  let isResetting = false;

  const dispatcher = new SceneInteractionDispatcher({
    camera,
    stateQuery: {
      isFullyOpen: () => true,
      isHoveringBottle: () => isHovering,
      isSessionResetting: () => isResetting,
    },
    actions: {
      onBottleClick: () => { bottleFired = true; },
    },
  });

  const rect = { left: 0, top: 0, width: 1000, height: 1000 };
  // 空白位置点击，当处于悬停且未在换页复显时，视作点击墨水瓶
  const res1 = dispatcher.dispatchClick(50, 50, rect);
  assert.strictEqual(res1, 'bottle');
  assert.strictEqual(bottleFired, true);

  // 当正在换页复显转场时 (ADR-0017)，屏蔽悬停捕获兜底，保护合书入口
  bottleFired = false;
  isResetting = true;
  let outsideFired = false;
  dispatcher.actions.onOutsideClick = () => { outsideFired = true; };

  const res2 = dispatcher.dispatchClick(50, 50, rect);
  assert.strictEqual(res2, 'outside');
  assert.strictEqual(bottleFired, false);
  assert.strictEqual(outsideFired, true);
});

test('SceneInteractionDispatcher dispatches book mesh hit with intersection data', () => {
  const camera = createMockCamera();
  const geom = new THREE.BoxGeometry(2, 0.1, 2);
  const mat = new THREE.MeshBasicMaterial();
  const bookMesh = new THREE.Mesh(geom, mat);
  bookMesh.position.set(0, 0, 0);
  bookMesh.updateMatrixWorld();

  let bookHitData = null;

  const dispatcher = new SceneInteractionDispatcher({
    camera,
    targets: {
      bookObjects: [bookMesh],
    },
    actions: {
      onBookClick: (hit) => { bookHitData = hit; },
    },
  });

  const rect = { left: 0, top: 0, width: 1000, height: 1000 };
  const res = dispatcher.dispatchClick(500, 500, rect);
  assert.strictEqual(res, 'book');
  assert.ok(bookHitData !== null);
  assert.strictEqual(bookHitData.object, bookMesh);
});

test('SceneInteractionDispatcher dispatchPointerMove and dispatchPointerLeave handle hover and gating', () => {
  const camera = createMockCamera();
  // 创建左页几何体 (x 偏向负轴)
  const geom = new THREE.BoxGeometry(1, 0.1, 1);
  const mat = new THREE.MeshBasicMaterial();
  const leftBookMesh = new THREE.Mesh(geom, mat);
  leftBookMesh.position.set(-0.5, 0, 0);
  leftBookMesh.updateMatrixWorld();

  let hoverHit = null;
  let isResetting = false;
  let isFullyOpen = true;

  const dispatcher = new SceneInteractionDispatcher({
    camera,
    targets: {
      bookObjects: [leftBookMesh],
    },
    stateQuery: {
      isFullyOpen: () => isFullyOpen,
      isSessionResetting: () => isResetting,
    },
    actions: {
      onBookHover: (hit) => { hoverHit = hit; },
    },
  });

  const rect = { left: 0, top: 0, width: 1000, height: 1000 };

  // 1. 命中左页书面 (x < 0)
  // 鼠标在屏幕左半部分 (300, 500)
  const res1 = dispatcher.dispatchPointerMove(300, 500, rect);
  assert.strictEqual(res1, 'book');
  assert.ok(hoverHit !== null);
  assert.ok(hoverHit.point.x < 0);

  // 2. 移出至空白桌面/右侧 (800, 500)
  const res2 = dispatcher.dispatchPointerMove(800, 500, rect);
  assert.strictEqual(res2, 'none');
  assert.strictEqual(hoverHit, null);

  // 3. 翻页转场中门控拦截
  isResetting = true;
  const res3 = dispatcher.dispatchPointerMove(300, 500, rect);
  assert.strictEqual(res3, 'blocked');
  assert.strictEqual(hoverHit, null);
  isResetting = false;

  // 4. 未完全展开时门控拦截
  isFullyOpen = false;
  const res4 = dispatcher.dispatchPointerMove(300, 500, rect);
  assert.strictEqual(res4, 'blocked');
  assert.strictEqual(hoverHit, null);

  // 5. 移出画布
  dispatcher.dispatchPointerLeave();
  assert.strictEqual(hoverHit, null);
});

test('SceneInteractionDispatcher avoids duplicate raycasting when pointer coordinates are unchanged', () => {
  const camera = createMockCamera();
  const geom = new THREE.BoxGeometry(1, 0.1, 1);
  const mat = new THREE.MeshBasicMaterial();
  const leftBookMesh = new THREE.Mesh(geom, mat);
  leftBookMesh.position.set(-0.5, 0, 0);
  leftBookMesh.updateMatrixWorld();

  const dispatcher = new SceneInteractionDispatcher({
    camera,
    targets: { bookObjects: [leftBookMesh] },
    stateQuery: { isFullyOpen: () => true },
  });

  let raycastCount = 0;
  const originalIntersect = dispatcher.raycaster.intersectObjects.bind(dispatcher.raycaster);
  dispatcher.raycaster.intersectObjects = (...args) => {
    raycastCount++;
    return originalIntersect(...args);
  };

  const rect = { left: 0, top: 0, width: 1000, height: 1000 };
  const res1 = dispatcher.dispatchPointerMove(300, 500, rect);
  assert.strictEqual(res1, 'book');
  assert.strictEqual(raycastCount, 1);

  // 相同坐标再次触发，应直接复用结果，不重复执行射线检测
  const res2 = dispatcher.dispatchPointerMove(300, 500, rect);
  assert.strictEqual(res2, 'book');
  assert.strictEqual(raycastCount, 1);

  // 坐标变更，触发新射线
  const res3 = dispatcher.dispatchPointerMove(310, 500, rect);
  assert.strictEqual(res3, 'book');
  assert.strictEqual(raycastCount, 2);
});
