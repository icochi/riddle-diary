import test from 'node:test';
import assert from 'node:assert';
import { evaluatePageSurface } from '../src/page-surface-evaluator.js';

test('get3DPosition surface evaluation aligns accurately with 2D ink canvas texture UV mapping', () => {
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

  const result = evaluatePageSurface(canvasPos);

  const texU = canvasPos.x / TEX_SIZE;
  const expectedMeshUvX = (texU - 0.5) * 2.0;
  const texV = canvasPos.y / TEX_SIZE;
  const expectedZ = (texV - 0.5) * 2.0;

  // 正确映射下，世界坐标 X 对应网格原生 uv.x 处的物理弯曲位置 (~0.1375m)，消除了未考虑曲面弧度的 ~5mm 偏差
  assert.ok(
    Math.abs(result.position.x - 0.1375) < 0.005,
    `Surface X should be near 0.1375, but got ${result.position.x}`
  );
  assert.ok(
    Math.abs(result.position.z - expectedZ) < 0.001,
    `Surface Z should match expectedZ ${expectedZ}, but got ${result.position.z}`
  );
  // 法线应向上并垂直于微弧表面
  assert.ok(result.normal.y > 0.9, `Normal Y should be near 1.0, got ${result.normal.y}`);
});
