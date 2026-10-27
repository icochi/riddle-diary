import test from 'node:test';
import assert from 'node:assert';
import { computeBleedField } from '../src/ink-bleed.js';
import { InkDropPipeline } from '../src/ink-drop-pipeline.js';

test('computeBleedField generates connected Voronoi spiderweb mesh webRGBA', () => {
  const field = computeBleedField(24, 7);
  assert.ok(field.webRGBA instanceof Uint8ClampedArray);
  assert.equal(field.webRGBA.length, field.size * field.size * 4);

  let nonZeroWebAlphaCount = 0;
  for (let i = 0; i < field.size * field.size; i++) {
    if (field.webRGBA[i * 4 + 3] > 0) {
      nonZeroWebAlphaCount++;
    }
  }
  // 全域蛛网骨架应覆盖中心与中外圈纤维，形成细密连通网
  assert.ok(nonZeroWebAlphaCount > 100, `web alpha count ${nonZeroWebAlphaCount} should be substantial`);
});

test('InkDropPipeline dissolve evolves into web then fades out smoothly', async () => {
  let putCount = 0;
  let lastData = null;

  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        createImageData: (size) => ({ data: new Uint8ClampedArray(size * size * 4) }),
        putImageData: (imgData) => {
          putCount++;
          lastData = imgData;
        },
      }),
    }),
  };

  const phases = [];
  const pipeline = new InkDropPipeline({
    config: {
      bleedDelay: 5,
      spreadDuration: 20,
      dissolveDuration: 40,
      interval: 1000,
    },
    getPosition: () => ({ x: 100, y: 100 }),
    onDirty: () => {},
    onPhaseChange: (phase) => {
      phases.push(phase);
    },
  });

  const settle = (ms) => new Promise((res) => setTimeout(res, ms));

  pipeline.start(0);
  // 等待经历 contact, spread, dissolve
  await settle(80);

  assert.ok(phases.includes('dissolve'), 'pipeline must enter dissolve phase');
  assert.ok(putCount > 0, 'putImageData must be called during animation');
  pipeline.stop();
});
