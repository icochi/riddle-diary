import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  extractInkFromImageData,
  bakeSkeletonToGreenChannel,
  evaluateDissolveAtProgress,
  SvgInkAnimator,
  SvgAnimState,
} from '../src/svg-ink-pipeline.js';

test('image.svg 资产文件存在且结构规范', () => {
  const svgPath = resolve('public/assets/image.svg');
  assert.ok(existsSync(svgPath), 'public/assets/image.svg 必须存在');
  const content = readFileSync(svgPath, 'utf-8');
  assert.ok(content.startsWith('<svg'), '文件必须以 <svg 标签起始');
  assert.ok(content.includes('viewBox="0 0 1865 576"'), 'viewBox 必须为 1865x576');
  assert.ok(content.includes('fill="#010101"'), '必须包含主体黑色笔触路径');
});

test('extractInkFromImageData 灰度反显能够精准剔除白色背景并提取墨水浓度', () => {
  const w = 4;
  const h = 2;
  const rawData = new Uint8ClampedArray(w * h * 4);

  // 像素 0: 纯白背景 (255, 255, 255, 255)
  rawData[0] = 255; rawData[1] = 255; rawData[2] = 255; rawData[3] = 255;
  // 像素 1: 纯黑墨迹 (0, 0, 0, 255)
  rawData[4] = 0; rawData[5] = 0; rawData[6] = 0; rawData[7] = 255;
  // 像素 2: 灰色抗锯齿过渡 (128, 128, 128, 255)
  rawData[8] = 128; rawData[9] = 128; rawData[10] = 128; rawData[11] = 255;
  // 像素 3: 留白孔洞 (250, 250, 250, 255)
  rawData[12] = 250; rawData[13] = 250; rawData[14] = 250; rawData[15] = 255;

  const result = extractInkFromImageData({ width: w, height: h, data: rawData }, { inkThreshold: 10 });
  const d = result.data;

  // 纯白背景 -> 完全透明
  assert.equal(d[3], 0, '纯白像素提取后 Alpha 必须为 0');

  // 纯黑墨水 -> 浓墨饱满 (Alpha 近 255)
  assert.ok(d[7] >= 250, '纯黑像素提取后 Alpha 必须接近 255');
  assert.equal(d[4], 27, '墨水 R 色相必须为铁胆墨深色');
  assert.equal(d[6], 12, '墨水 B 色相必须为铁胆墨深色');

  // 灰度抗锯齿 -> 对应半透明
  assert.ok(d[11] >= 115 && d[11] <= 135, '灰色过渡像素必须保留半透明抗锯齿');

  // 留白孔洞 -> 过滤为透明
  assert.equal(d[15], 0, '孔洞留白像素必须过滤为 0');
});

test('bakeSkeletonToGreenChannel 成功将骨架中轴写入 Green 通道', () => {
  const w = 32;
  const h = 32;
  const inkData = new Uint8ClampedArray(w * h * 4);

  // 在中央绘制一条厚度为 10px 的实心墨水横杠
  for (let y = 11; y <= 21; y++) {
    for (let x = 4; x <= 27; x++) {
      const idx = (y * w + x) * 4;
      inkData[idx] = 27;
      inkData[idx + 1] = 0;
      inkData[idx + 2] = 12;
      inkData[idx + 3] = 255;
    }
  }

  const { bakedImageData, skeleton } = bakeSkeletonToGreenChannel({ width: w, height: h, data: inkData });
  const baked = bakedImageData.data;

  // 边缘处的骨架值应显著小于中心处
  const edgeIdx = (11 * w + 16) * 4;
  const centerIdx = (16 * w + 16) * 4;

  const edgeGreen = baked[edgeIdx + 1];
  const centerGreen = baked[centerIdx + 1];

  assert.ok(centerGreen > edgeGreen, '中轴中心骨架深度必须大于边缘骨架深度');
  assert.ok(centerGreen >= 200, '中轴骨核处 Green 通道归一化值必须接近 255');
});

test('evaluateDissolveAtProgress 在消融与反显过程中严格保持单调性与终态一致性', () => {
  const w = 30;
  const h = 30;
  const srcData = new Uint8ClampedArray(w * h * 4);

  // 构造带有中心骨架梯度的圆形墨滴
  const cx = 15;
  const cy = 15;
  const radius = 10;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dist = Math.hypot(x - cx, y - cy);
      if (dist <= radius) {
        const idx = (y * w + x) * 4;
        const normDepth = Math.max(0, 1.0 - dist / radius);
        srcData[idx] = 27;
        srcData[idx + 1] = Math.round(normDepth * 255); // Green 骨架
        srcData[idx + 2] = 12;
        srcData[idx + 3] = 255;
      }
    }
  }

  const baked = { width: w, height: h, data: srcData };

  // 1. 完全饱满显影态 (activeDissolve = 0.0)
  const full = evaluateDissolveAtProgress(baked, 0.0);
  let fullCount = 0;
  for (let i = 0; i < w * h; i++) {
    if (full.data[i * 4 + 3] > 0) fullCount++;
  }
  assert.ok(fullCount > 250, '饱满显影态有效像素数必须保持全量');

  // 2. 中度消融态 (activeDissolve = 0.5)
  const half = evaluateDissolveAtProgress(baked, 0.5);
  let halfCount = 0;
  for (let i = 0; i < w * h; i++) {
    if (half.data[i * 4 + 3] > 0) halfCount++;
  }
  assert.ok(halfCount < fullCount, '中度消融态有效像素数必须少于全量态（笔画收缩）');
  assert.ok(halfCount > 0, '中度消融态仍应保留骨核像素');

  // 3. 完全消融吸干态 (activeDissolve = 1.0)
  const empty = evaluateDissolveAtProgress(baked, 1.0);
  let emptyCount = 0;
  for (let i = 0; i < w * h; i++) {
    if (empty.data[i * 4 + 3] > 0) emptyCount++;
  }
  assert.equal(emptyCount, 0, '完全消融态所有像素必须吸干彻底隐匿');
});

test('SvgInkAnimator 控制器状态机与步进功能正确', () => {
  const w = 10;
  const h = 10;
  const baked = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };

  let lastDissolve = -1;
  let lastPhase = '';
  const animator = new SvgInkAnimator({
    bakedImageData: baked,
    onRender: (dissolve, phase) => {
      lastDissolve = dissolve;
      lastPhase = phase;
    },
    emergeDuration: 100,
    dissolveDuration: 100,
    stayDuration: 100,
  });

  assert.equal(animator.state, SvgAnimState.IDLE);

  // 手动 seek
  animator.seek(0.65);
  assert.equal(animator.currentDissolve, 0.65);
  assert.equal(lastDissolve, 0.65);
  assert.equal(lastPhase, 'manual');

  animator.stop();
  assert.equal(animator.isLooping, false);
});

test('日记翻开摊平落定时必须联动播放 playOpeningSvgDissolve', () => {
  const mainJs = readFileSync(resolve('src/main.js'), 'utf-8');
  assert.ok(
    mainJs.includes('inkSystem.playOpeningSvgDissolve'),
    'main.js 必须调用 inkSystem.playOpeningSvgDissolve'
  );
  assert.ok(
    mainJs.includes('if (isFullyOpen && !wasFullyOpen)'),
    'main.js 翻开摊平落定时必须联动播放 playOpeningSvgDissolve'
  );
});
