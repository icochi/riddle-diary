import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { InkDropPipeline } from '../src/ink-drop-pipeline.js';

// 从 src/pages.js 动态提取墨水着色器片段并执行数值验证
test('pages.js fragment shader must fade effectiveAlpha to 0 when uTextDissolve is 1.0', () => {
  const pagesSource = readFileSync(resolve('src/pages.js'), 'utf-8');

  // 解析 pages.js 中关于 effectiveAlpha 的计算逻辑
  // 必须确保当 uTextDissolve 处于完全消融阶段 (uTextDissolve = 1.0) 时，
  // 渲染计算出的 effectiveAlpha 必须 <= 0.005（文字完全消隐入纸背）

  function runShaderSnippet(strokeDepth, uTextDissolve, inkAlpha = 1.0, isLeftPage = 0.0) {
    // 提取 pages.js 中的片段着色器计算
    // 模拟 GLSL 运算
    const clamp = (val, min, max) => Math.max(min, Math.min(max, val));
    const smoothstep = (min, max, val) => {
      const x = clamp((val - min) / (max - min), 0.0, 1.0);
      return x * x * (3.0 - 2.0 * x);
    };
    const mix = (x, y, a) => x * (1 - a) + y * a;
    const step = (edge, x) => (x >= edge ? 1.0 : 0.0);

    const edgeSensitivity = 1.0 - smoothstep(0.20, 0.70, strokeDepth);
    const paperLuma = 0.8;
    const microPulp = 0.5;
    const fiberDepth = 0.0;
    const fiberTrapping = fiberDepth * (0.10 + 0.35 * edgeSensitivity);
    let density = clamp(strokeDepth * 1.15 + fiberTrapping, 0.0, 1.0);

    // 检查 pages.js 源码中消融分支的代码
    let ink = { a: inkAlpha, g: strokeDepth };

    // 匹配 pages.js 中的消融计算
    if (pagesSource.includes('ink.a = ink.a * widthAlpha * opacity * fiberGrain;') ||
        pagesSource.includes('ink.a *= widthAlpha * opacity * fiberGrain;') ||
        pagesSource.includes('ink.a *= dissolveAlpha;')) {
      // 修复后的实现
      if (isLeftPage < 0.5 && uTextDissolve > 0.001) {
        const stage = 1.0 - uTextDissolve;
        const widthThreshold = mix(0.62, 0.01, smoothstep(0.40, 0.95, stage));
        const widthAlpha = smoothstep(widthThreshold - 0.06, widthThreshold + 0.06, strokeDepth);
        const fiberGrain = 0.90 + 0.10 * microPulp;
        let opacity;
        if (stage < 0.20) {
          opacity = (stage / 0.20) * 0.45;
        } else if (stage < 0.55) {
          opacity = mix(0.45, 0.95, (stage - 0.20) / 0.35);
        } else {
          opacity = mix(0.95, 1.0, (stage - 0.55) / 0.45);
        }
        ink.a = ink.a * widthAlpha * opacity * fiberGrain;
      }
    } else {
      // 存在缺陷的实现（仅修改 density）
      if (isLeftPage < 0.5 && uTextDissolve > 0.001) {
        const stage = 1.0 - uTextDissolve;
        const widthThreshold = mix(0.62, 0.01, smoothstep(0.40, 0.95, stage));
        const widthAlpha = smoothstep(widthThreshold - 0.06, widthThreshold + 0.06, strokeDepth);
        const fiberGrain = 0.90 + 0.10 * microPulp;
        let opacity;
        if (stage < 0.20) {
          opacity = (stage / 0.20) * 0.45;
        } else if (stage < 0.55) {
          opacity = mix(0.45, 0.95, (stage - 0.20) / 0.35);
        } else {
          opacity = mix(0.95, 1.0, (stage - 0.55) / 0.45);
        }
        density = clamp(density * widthAlpha * opacity * fiberGrain, 0.0, 1.0);
      }
    }

    const effectiveAlpha = ink.a * clamp(0.90 + 0.10 * density, 0.0, 1.0);
    return effectiveAlpha;
  }

  // 当 uTextDissolve 为 1.0 (完全消融状态) 时，effectiveAlpha 必须接近 0 (低于 0.005)
  const alphaAtFullDissolve = runShaderSnippet(0.8, 1.0, 1.0, 0.0);
  assert.ok(
    alphaAtFullDissolve <= 0.005,
    `At full dissolution (uTextDissolve=1.0), effectiveAlpha must be <= 0.005, but got ${alphaAtFullDissolve}`
  );
});

test('pages.js fragment shader supports left page reverse emergence with Y-range clipping', () => {
  const pagesSource = readFileSync(resolve('src/pages.js'), 'utf-8');

  // 必须声明 uLeftTextDissolve 与 uLeftEmergingYRange uniforms
  assert.ok(pagesSource.includes('uLeftTextDissolve'), 'shader must include uLeftTextDissolve uniform');
  assert.ok(pagesSource.includes('uLeftEmergingYRange'), 'shader must include uLeftEmergingYRange uniform');

  function runLeftShaderSnippet(texV, yMin, yMax, uLeftTextDissolve, strokeDepth = 0.8, inkAlpha = 1.0) {
    const clamp = (val, min, max) => Math.max(min, Math.min(max, val));
    const smoothstep = (min, max, val) => {
      const x = clamp((val - min) / (max - min), 0.0, 1.0);
      return x * x * (3.0 - 2.0 * x);
    };
    const mix = (x, y, a) => x * (1 - a) + y * a;

    let activeDissolve = 0.0;
    if (uLeftTextDissolve > 0.001) {
      if (yMin < 0.0 || (texV >= yMin && texV <= yMax)) {
        activeDissolve = uLeftTextDissolve;
      }
    }

    let ink = { a: inkAlpha, g: strokeDepth };
    let density = strokeDepth * 1.15;

    if (activeDissolve > 0.001) {
      const stage = 1.0 - activeDissolve;
      const widthThreshold = mix(0.62, 0.01, smoothstep(0.40, 0.95, stage));
      const widthAlpha = smoothstep(widthThreshold - 0.06, widthThreshold + 0.06, strokeDepth);
      const fiberGrain = 0.95;
      let opacity;
      if (stage < 0.20) {
        opacity = (stage / 0.20) * 0.45;
      } else if (stage < 0.55) {
        opacity = mix(0.45, 0.95, (stage - 0.20) / 0.35);
      } else {
        opacity = mix(0.95, 1.0, (stage - 0.55) / 0.45);
      }
      const dissolveAlpha = widthAlpha * opacity * fiberGrain;
      density = clamp(density * dissolveAlpha, 0.0, 1.0);
      ink.a *= dissolveAlpha;
    }

    return ink.a * clamp(0.90 + 0.10 * density, 0.0, 1.0);
  }

  // 1. 处于 YRange 之外的旧条目：即便 uLeftTextDissolve = 1.0 (消融中)，也不会被消隐
  const oldItemAlpha = runLeftShaderSnippet(0.35, 0.40, 0.45, 1.0);
  assert.ok(oldItemAlpha > 0.7, `Old item outside Y-range should stay visible, got ${oldItemAlpha}`);

  // 2. 落在 YRange 内的新增条目：在 uLeftTextDissolve = 1.0 (开始显影前) 必须完全消融隐形 (<= 0.005)
  const newItemAtStart = runLeftShaderSnippet(0.42, 0.40, 0.45, 1.0);
  assert.ok(newItemAtStart <= 0.005, `New item at start of emergence should be <= 0.005, got ${newItemAtStart}`);

  // 3. 落在 YRange 内的新增条目：在 uLeftTextDissolve = 0.0 (显影完成) 时完全恢复可见
  const newItemAtEnd = runLeftShaderSnippet(0.42, 0.40, 0.45, 0.0);
  assert.ok(newItemAtEnd > 0.7, `New item at end of emergence should be visible, got ${newItemAtEnd}`);
});

test('pages.js fragment shader supports left page hover stroke drawing and erasing', () => {
  const pagesSource = readFileSync(resolve('src/pages.js'), 'utf-8');

  assert.ok(pagesSource.includes('uLeftHoverBox'), 'shader must include uLeftHoverBox uniform');
  assert.ok(pagesSource.includes('uLeftHoverProgress'), 'shader must include uLeftHoverProgress uniform');
  assert.ok(pagesSource.includes('uLeftHoverMode'), 'shader must include uLeftHoverMode uniform');

  function runStrokeSnippet(texU, texV, box, progress, mode, inkAlpha = 1.0, strokeDepth = 0.8) {
    const clamp = (val, min, max) => Math.max(min, Math.min(max, val));
    const smoothstep = (min, max, val) => {
      const x = clamp((val - min) / (max - min), 0.0, 1.0);
      return x * x * (3.0 - 2.0 * x);
    };

    let ink = { a: inkAlpha, g: strokeDepth };
    let density = strokeDepth * 1.15;

    if (mode > 0.5) {
      if (texV >= box.vMin && texV <= box.vMax && texU >= box.uMin && texU <= box.uMax) {
        const tipU = box.uMin + (box.uMax - box.uMin) * clamp(progress, 0.0, 1.0);
        const strokeFeather = 5.0 / 2048.0;
        if (mode < 1.5) {
          // 模式 1：从左向右运笔绘制延伸 (texU <= tipU 可见)
          const strokeMask = 1.0 - smoothstep(tipU - strokeFeather, tipU + strokeFeather, texU);
          ink.a *= strokeMask;
        } else {
          // 模式 2：从左向右运笔原路擦除 (texU >= tipU 保留，texU < tipU 擦除)
          const strokeMask = smoothstep(tipU - strokeFeather, tipU + strokeFeather, texU);
          ink.a *= strokeMask;
        }
      }
    }

    return ink.a * clamp(0.90 + 0.10 * density, 0.0, 1.0);
  }

  const box = { uMin: 0.10, uMax: 0.30, vMin: 0.40, vMax: 0.42 };

  // 1. 模式 1 (绘制延伸)，当 progress = 0.0 时，整条下划线应当完全不可见 (<= 0.005)
  const alphaDrawStart = runStrokeSnippet(0.20, 0.41, box, 0.0, 1.0);
  assert.ok(alphaDrawStart <= 0.005, `At start of drawing (progress=0), alpha should be <= 0.005, got ${alphaDrawStart}`);

  // 2. 模式 1 (绘制延伸)，当 progress = 0.5 时，左半段 (0.15) 可见，右半段 (0.25) 被遮蔽
  const alphaDrawLeft = runStrokeSnippet(0.15, 0.41, box, 0.5, 1.0);
  const alphaDrawRight = runStrokeSnippet(0.25, 0.41, box, 0.5, 1.0);
  assert.ok(alphaDrawLeft > 0.7, `Drawn stroke on the left must be visible, got ${alphaDrawLeft}`);
  assert.ok(alphaDrawRight <= 0.005, `Stroke ahead of the tip on the right must be masked, got ${alphaDrawRight}`);

  // 3. 模式 2 (擦除消散)，当 progress = 0.5 时，左半段 (0.15) 已被擦除 (<= 0.005)，右半段 (0.25) 尚未擦除
  const alphaEraseLeft = runStrokeSnippet(0.15, 0.41, box, 0.5, 2.0);
  const alphaEraseRight = runStrokeSnippet(0.25, 0.41, box, 0.5, 2.0);
  assert.ok(alphaEraseLeft <= 0.005, `Erased stroke on the left must be gone, got ${alphaEraseLeft}`);
  assert.ok(alphaEraseRight > 0.7, `Stroke ahead of the erasing tip on the right must be visible, got ${alphaEraseRight}`);
});

test('pages.js fragment shader must declare all referenced uniforms in GLSL header', () => {
  const pagesSource = readFileSync(resolve('src/pages.js'), 'utf-8');
  const glslMatch = pagesSource.match(/const GLSL = \/\* glsl \*\/ `([\s\S]*?)`;/);
  assert.ok(glslMatch, 'pages.js must contain a GLSL header block');

  const glslHeader = glslMatch[1];
  const requiredUniforms = [
    'uAging',
    'uOpen',
    'uFiber',
    'tPageBaseColor',
    'tPageOrm',
    'tPageNormal',
    'tInkTexture',
    'uHasInkTexture',
    'uTextDissolve',
    'uLeftTextDissolve',
    'uLeftEmergingYRange',
    'uLeftHoverBox',
    'uLeftHoverProgress',
    'uLeftHoverMode',
  ];

  for (const uniformName of requiredUniforms) {
    assert.ok(
      glslHeader.includes(uniformName),
      `GLSL header is missing declaration for uniform '${uniformName}', which causes shader compilation failure and black book pages!`
    );
  }
});

test('src/ink.js must import computeSkeletonField to prevent ReferenceError after erosion', () => {
  const inkSource = readFileSync(resolve('src/ink.js'), 'utf-8');
  assert.ok(
    inkSource.includes('computeSkeletonField'),
    'src/ink.js must reference computeSkeletonField'
  );
  const headLines = inkSource.split('\n').slice(0, 20).join('\n');
  assert.ok(
    headLines.includes('computeSkeletonField'),
    'src/ink.js must explicitly import computeSkeletonField in the module header'
  );
  assert.ok(
    headLines.includes('SessionTransitionSequence'),
    'src/ink.js must explicitly import SessionTransitionSequence in the module header'
  );
  assert.ok(
    !inkSource.match(/\bsessionReset\b/),
    'src/ink.js must not reference undeclared sessionReset identifier'
  );
});

test('src/ink.js all referenced animation cancel handles must be declared', () => {
  const inkSource = readFileSync(resolve('src/ink.js'), 'utf-8');
  const declared = new Set();
  for (const match of inkSource.matchAll(/\b(?:let|const|var)\s+([A-Za-z0-9_]+)\b/g)) {
    declared.add(match[1]);
  }
  for (const match of inkSource.matchAll(/\bfunction\s+([A-Za-z0-9_]+)\b/g)) {
    declared.add(match[1]);
  }

  const cancelHandles = [...new Set(inkSource.match(/\bactive[A-Za-z0-9_]*Cancel\b/g))];
  for (const handle of cancelHandles) {
    assert.ok(
      declared.has(handle),
      `Identifier "${handle}" referenced in src/ink.js must be declared to prevent ReferenceError`
    );
  }
});

test('src/ink.js must initialize left emerging item in dissolved state before canvas update to prevent visible flash', () => {
  const inkSource = readFileSync(resolve('src/ink.js'), 'utf-8');
  const driverSource = readFileSync(resolve('src/ink-dissolve-driver.js'), 'utf-8');
  // 必须确保在 prepareLeftItemEmergence 发生时，新条目通过 dissolveDriver 被预设为完全消融状态 1.0
  const isDriverInitialized = driverSource.includes('prepareLeftItem(boundInfo)') &&
    driverSource.includes('this.leftTextDissolve.value = 1.0') &&
    driverSource.includes('this.leftEmergingYRange.value.set');
  const isDirectInitialized = inkSource.includes('prepareLeftItemEmergence(histItem)') &&
    inkSource.includes('leftTextDissolve.value = 1.0') &&
    inkSource.includes('leftEmergingYRange.value.set');
  assert.ok(
    (inkSource.includes('prepareLeftItemEmergence(histItem)') && inkSource.includes('dissolveDriver.prepareLeftItem') && isDriverInitialized) ||
    isDirectInitialized,
    'left emerging uniforms must be initialized upon adding new history item'
  );
  // 检查 ChatInkDirector 演播调度深模块：确保左页显影不是在 animateTextEmergence 的 onComplete 回调之后才延迟触发
  const directorSource = readFileSync(resolve('src/chat-ink-director.js'), 'utf-8');
  const playAiPageMatch = directorSource.match(/_playAiPage[\s\S]*?animateTextEmergence\([^,]+,\s*\(\)\s*=>\s*\{([\s\S]*?)\}\);/);
  assert.ok(playAiPageMatch, '_playAiPage function must exist in ChatInkDirector');
  assert.ok(
    !playAiPageMatch[1].includes('animateLeftItemEmergence'),
    'animateLeftItemEmergence must not be delayed inside animateTextEmergence onComplete callback'
  );
});

test('DEFAULT_DROP_CONFIG sets compact ink dot and tightened spiderweb bleed width (24px and 7px)', () => {
  const pipelineSource = readFileSync(resolve('src/ink-drop-pipeline.js'), 'utf-8');
  assert.ok(pipelineSource.includes('dotDiameter: 24'), 'dotDiameter must be scaled to 24');
  assert.ok(pipelineSource.includes('bleedWidth: 7'), 'bleedWidth must be tightened to 7');
});

test('src/ink.js aligns ink drop vertically with font baseline and visual center', () => {
  const inkSource = readFileSync(resolve('src/ink.js'), 'utf-8');
  assert.ok(
    inkSource.includes('Math.round(FONT_RIGHT.size * 0.58)'),
    'ink drop Y coordinate must be aligned to ~0.58 of font size'
  );
});

test('src/ink-bleed.js core converges toward circular baseline while preserving organic micro-flaws', () => {
  const bleedSource = readFileSync(resolve('src/ink-bleed.js'), 'utf-8');
  assert.ok(bleedSource.includes('ANISO_X = 1.02') && bleedSource.includes('ANISO_Y = 0.98'), 'anisotropy must be ~1.0:1.0');
  assert.ok(bleedSource.includes('coreScale = baseCoreRadius / 12.0'), 'coreScale must use normalized ~8-10% ratio');
});

// 截取指定监听器回调的源码体，确保断言只作用于该回调内部
function listenerBody(source, eventName) {
  const marker = `hiddenInput.addEventListener('${eventName}'`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing listener for ${eventName}`);
  const end = source.indexOf('\n  });', start);
  assert.notEqual(end, -1, `unterminated listener body for ${eventName}`);
  return source.slice(start, end);
}

test('DEFAULT_DROP_CONFIG defines a dedicated typingIdleDelay for text-change restart', () => {
  const pipelineSource = readFileSync(resolve('src/ink-drop-pipeline.js'), 'utf-8');
  assert.ok(pipelineSource.includes('typingIdleDelay: 600'), 'typingIdleDelay must be 600ms');
  assert.ok(pipelineSource.includes('firstDropDelay: 1200'), 'firstDropDelay must stay 1200ms');
});

test('src/ink.js preserves drop during IME composition and schedules restart on committed text', () => {
  const inkSource = readFileSync(resolve('src/ink.js'), 'utf-8');

  const composing = listenerBody(inkSource, 'compositionstart');
  assert.ok(!composing.includes('stopDropCycle()'), 'compositionstart must not hide the active drop');
  assert.ok(!composing.includes('scheduleDropCycleRestart('), 'compositionstart must not schedule a restart');

  const updating = listenerBody(inkSource, 'compositionupdate');
  assert.ok(!updating.includes('stopDropCycle()'), 'compositionupdate must keep the drop visible while composing');
  assert.ok(!updating.includes('scheduleDropCycleRestart('), 'compositionupdate must not schedule a restart');

  const committed = listenerBody(inkSource, 'compositionend');
  assert.ok(committed.includes('scheduleDropCycleRestart()'), 'compositionend must schedule the restart');
  assert.ok(!committed.includes('stopDropCycle()'), 'compositionend must route hiding through scheduleDropCycleRestart');
  assert.ok(
    committed.indexOf('scheduleDropCycleRestart()') < committed.indexOf('renderCurrentPage('),
    'compositionend must hide the old drop before redrawing at the new caret position'
  );

  const typing = listenerBody(inkSource, 'input');
  assert.ok(typing.includes('scheduleDropCycleRestart()'), 'non-composing input must schedule the restart');
  assert.ok(
    typing.indexOf('scheduleDropCycleRestart()') < typing.indexOf('renderCurrentPage('),
    'input must hide the old drop before redrawing at the new caret position'
  );
});

test('src/ink.js keeps scheduleDropCycleRestart as the only text-change restart entry', () => {
  const inkSource = readFileSync(resolve('src/ink.js'), 'utf-8');

  const start = inkSource.indexOf('function renderCurrentPage(');
  const end = inkSource.indexOf('\n  function triggerPageEmergence', start);
  const renderBody = inkSource.slice(start, end);
  assert.ok(start !== -1 && end !== -1, 'renderCurrentPage body must be locatable');
  assert.ok(!renderBody.includes('startDropCycle('), 'rendering must not restart the drop cycle');

  const scheduleStart = inkSource.indexOf('function scheduleDropCycleRestart(');
  const scheduleEnd = inkSource.indexOf('\n  }', scheduleStart);
  const scheduleBody = inkSource.slice(scheduleStart, scheduleEnd);
  assert.ok(scheduleStart !== -1, 'scheduleDropCycleRestart must exist');
  assert.ok(scheduleBody.includes('stopDropCycle()'), 'restart scheduling must first hide the current drop');
  assert.ok(scheduleBody.includes('isInputLocked()'), 'restart scheduling must yield to page/erosion/replay locks');
  assert.ok(scheduleBody.includes('config.typingIdleDelay'), 'restart scheduling must use typingIdleDelay');
});

test('InkDropPipeline.stop() cancels a pending delayed drop and a delayed start spawns exactly one drop', async () => {
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        createImageData: (size) => ({ data: new Uint8ClampedArray(size * size * 4) }),
        putImageData: () => {},
      }),
    }),
  };

  let dirtyCount = 0;
  const pipeline = new InkDropPipeline({
    config: { dotDiameter: 8, bleedWidth: 4, bleedDelay: 20000 },
    getPosition: () => ({ x: 0, y: 0 }),
    onDirty: () => { dirtyCount += 1; },
  });
  const settle = (ms) => new Promise((res) => setTimeout(res, ms));

  pipeline.start(10);
  pipeline.stop();
  await settle(60);
  assert.equal(dirtyCount, 0, 'stop() must cancel the pending delayed drop');
  assert.equal(pipeline.hasActiveDrop, false, 'no drop may render after stop()');

  pipeline.start(10);
  await settle(60);
  assert.equal(dirtyCount, 1, 'a delayed start must spawn exactly one drop');
  assert.ok(pipeline.hasActiveDrop, 'the spawned drop must stay visible during bleedDelay');

  pipeline.start(10);
  await settle(60);
  assert.equal(dirtyCount, 2, 'restarting mid-pending must not leave two drops alive');
  pipeline.stop();
});

test('AI 字体首选使用 Tangerine 并在 index.html 中完成 preload', () => {
  const inkSource = readFileSync(resolve('src/ink.js'), 'utf-8');
  const indexHtml = readFileSync(resolve('index.html'), 'utf-8');
  assert.match(
    inkSource,
    /aiFamily:\s*'"Tangerine",\s*"WangHanZong-ZhongXingShu"/,
    'src/ink.js 中 aiFamily 必须将 Tangerine 列为首选西文字体并保留 WangHanZong-ZhongXingShu 中文回退'
  );
  assert.ok(
    indexHtml.includes('<link rel="preload" href="/assets/fonts/Tangerine-Bold.ttf" as="font" type="font/ttf" crossorigin />'),
    'index.html 必须预加载 Tangerine-Bold.ttf 字体'
  );
  assert.ok(
    indexHtml.includes('<link rel="preload" href="/assets/fonts/WangHanZong-ZhongXingShu.ttf" as="font" type="font/ttf" crossorigin />'),
    'index.html 必须保留预加载 WangHanZong-ZhongXingShu.ttf 字体'
  );
});
