import test from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import {
  evaluatePageSurface,
  PageSurfaceEvaluator,
  PAGE_CURVE_TABLE,
  LEFT_PAGE_CURVE_TABLE,
} from '../src/page-surface-evaluator.js';

test('PageSurfaceEvaluator tables are well-formed and monotonic', () => {
  assert.ok(PAGE_CURVE_TABLE.length >= 30, 'Right page curve table should have at least 30 points');
  assert.ok(LEFT_PAGE_CURVE_TABLE.length >= 30, 'Left page curve table should have at least 30 points');

  for (let i = 1; i < PAGE_CURVE_TABLE.length; i++) {
    assert.ok(
      PAGE_CURVE_TABLE[i][0] >= PAGE_CURVE_TABLE[i - 1][0],
      `Right table U at ${i} must be monotonically non-decreasing`
    );
  }

  for (let i = 1; i < LEFT_PAGE_CURVE_TABLE.length; i++) {
    assert.ok(
      LEFT_PAGE_CURVE_TABLE[i][0] >= LEFT_PAGE_CURVE_TABLE[i - 1][0],
      `Left table U at ${i} must be monotonically non-decreasing`
    );
  }
});

test('evaluatePageSurface evaluates right page surface geometry accurately', () => {
  const TEX_SIZE = 2048;
  const FONT_RIGHT_size = 46;
  const RIGHT_PAGE = {
    x: TEX_SIZE * 0.56,
    y: TEX_SIZE * 0.29,
    w: TEX_SIZE * 0.36,
    h: TEX_SIZE * 0.45,
  };
  const dropOffsetY = Math.round(FONT_RIGHT_size * 0.58);
  const canvasPos = {
    x: RIGHT_PAGE.x + FONT_RIGHT_size * 0.5,
    y: RIGHT_PAGE.y + dropOffsetY,
  };

  const result = evaluatePageSurface(canvasPos, TEX_SIZE);

  const texU = canvasPos.x / TEX_SIZE;
  const texV = canvasPos.y / TEX_SIZE;
  const expectedZ = (texV - 0.5) * 2.0;

  assert.ok(
    Math.abs(result.position.x - 0.1375) < 0.005,
    `Right page surface X should be near 0.1375, got ${result.position.x}`
  );
  assert.ok(
    Math.abs(result.position.z - expectedZ) < 0.001,
    `Right page surface Z should match expectedZ ${expectedZ}, got ${result.position.z}`
  );
  assert.ok(result.normal.y > 0.9, `Normal Y should be near 1.0, got ${result.normal.y}`);
});

test('evaluatePageSurface evaluates left page surface geometry accurately', () => {
  const TEX_SIZE = 2048;
  const canvasPos = {
    x: TEX_SIZE * 0.2, // Left page (U < 0.5)
    y: TEX_SIZE * 0.5,
  };

  const result = evaluatePageSurface(canvasPos, TEX_SIZE);

  assert.ok(result.position.x < 0, `Left page surface X should be negative, got ${result.position.x}`);
  assert.ok(Math.abs(result.position.z) < 0.001, `Left page Z at center should be near 0, got ${result.position.z}`);
  assert.ok(result.normal.y > 0.8, `Normal Y on left page should be upward, got ${result.normal.y}`);
});

test('PageSurfaceEvaluator deep module wraps evaluation and supports Raycaster mesh intersection', () => {
  const evaluator = new PageSurfaceEvaluator({ texSize: 2048 });

  const canvasPos = { x: 1200, y: 700 };
  const baseResult = evaluator.evaluate(canvasPos);
  assert.ok(baseResult.position instanceof THREE.Vector3);
  assert.ok(baseResult.normal instanceof THREE.Vector3);

  // 构造模拟的三维日记本可拾取网格
  const geometry = new THREE.PlaneGeometry(2, 2);
  const material = new THREE.MeshBasicMaterial();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.145; // 略微浮空的基准网格
  mesh.updateMatrixWorld();

  evaluator.setBookMeshes([mesh]);
  const hitResult = evaluator.evaluate(canvasPos);

  assert.ok(
    Math.abs(hitResult.position.y - 0.145) < 0.001,
    `Raycaster should project onto book mesh at Y=0.145, got ${hitResult.position.y}`
  );
});

test('PageSurfaceEvaluator reuses cached result for identical canvasPos', () => {
  const evaluator = new PageSurfaceEvaluator({ texSize: 2048 });
  const pos = { x: 800, y: 600 };
  let raycastCount = 0;
  evaluator.raycaster.intersectObjects = () => {
    raycastCount++;
    return [{ point: new THREE.Vector3(0.1, 0.12, 0.1), face: { normal: new THREE.Vector3(0, 1, 0) } }];
  };
  evaluator.setBookMeshes([new THREE.Mesh()]);

  const res1 = evaluator.evaluate(pos);
  assert.equal(raycastCount, 1);

  // 相同坐标直接复用，不重复发起射线
  const res2 = evaluator.evaluate(pos);
  assert.equal(raycastCount, 1);
  assert.strictEqual(res1, res2);

  // 坐标变更发起新的求值
  evaluator.evaluate({ x: 801, y: 600 });
  assert.equal(raycastCount, 2);
});
