import test from 'node:test';
import assert from 'node:assert';
import { evaluatePageSurface, PAGE_CURVE_TABLE } from '../src/page-surface-evaluator.js';

test('PAGE_CURVE_TABLE must strictly match current diary-book.glb geometry without 11mm center deviation', () => {
  const TEX_SIZE = 2048;
  const FONT_RIGHT_size = 46;
  const RIGHT_PAGE = {
    x: TEX_SIZE * 0.56,
    y: TEX_SIZE * 0.29,
    w: TEX_SIZE * 0.36,
    h: TEX_SIZE * 0.45,
  };
  const dropOffsetY = Math.round(FONT_RIGHT_size * 0.58);

  // 中间区域采样：U ≈ 0.50 (对应 Canvas x ≈ 1538)
  const canvasPosMid = {
    x: 1538,
    y: RIGHT_PAGE.y + dropOffsetY,
  };

  const resultMid = evaluatePageSurface(canvasPosMid, TEX_SIZE);

  // 真实 3D 网格 leaf 10 在 U=0.50195 处的物理 X 坐标为 ~0.5146m
  // 旧表格在此处为 ~0.5032m，产生了整整 11.4mm 的严重偏差
  const expectedRealMeshX = 0.5146;
  const deviation = Math.abs(resultMid.position.x - expectedRealMeshX);

  assert.ok(
    deviation < 0.003,
    `Center droplet deviation must be under 3mm, but got ${(deviation * 1000).toFixed(1)}mm (x=${resultMid.position.x})`
  );
});
