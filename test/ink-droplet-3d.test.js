import test from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import { InkDroplet3D } from '../src/ink-droplet-3d.js';
import { InkDropPipeline, DEFAULT_DROP_CONFIG } from '../src/ink-drop-pipeline.js';
import { computeBleedField } from '../src/ink-bleed.js';

test('DEFAULT_DROP_CONFIG includes 3D droplet phase durations', () => {
  assert.equal(typeof DEFAULT_DROP_CONFIG.condenseDuration, 'number');
  assert.equal(typeof DEFAULT_DROP_CONFIG.condenseStay, 'number');
  assert.equal(typeof DEFAULT_DROP_CONFIG.absorbDuration, 'number');
  assert.equal(DEFAULT_DROP_CONFIG.condenseDuration, 350);
  assert.equal(DEFAULT_DROP_CONFIG.condenseStay, 500);
  assert.equal(DEFAULT_DROP_CONFIG.absorbDuration, 1200);
});

test('computeBleedField calculates inscribed circle radius', () => {
  const field = computeBleedField(24, 12);
  assert.ok(typeof field.inscribedRadius === 'number');
  assert.ok(field.inscribedRadius > 9 && field.inscribedRadius < 13);
});

test('InkDroplet3D creates mesh with physical material and single key-light highlight', () => {
  const scene = new THREE.Scene();
  const droplet = new InkDroplet3D({ scene, dotDiameter: 24 });

  assert.ok(droplet.mesh instanceof THREE.Mesh);
  assert.ok(droplet.mesh.material instanceof THREE.MeshPhysicalMaterial);
  assert.equal(droplet.mesh.visible, false);
  assert.equal(droplet.mesh.material.clearcoat, 1.0);
  assert.equal(droplet.mesh.material.envMap, null, 'must have null envMap for single key-light highlight');
  assert.ok(droplet.mesh.material.roughness <= 0.05);
  assert.ok(droplet.mesh.material.transparent);
  assert.equal(scene.children.includes(droplet.mesh), true);
});

test('InkDroplet3D setCondense and setAbsorb animate scale, clearcoat and roughness', () => {
  const scene = new THREE.Scene();
  const droplet = new InkDroplet3D({ scene, dotDiameter: 24 });

  droplet.setBaseRadius(10.8);
  droplet.showAt(new THREE.Vector3(0.5, 0.12, 0.0));
  assert.equal(droplet.mesh.visible, true);

  // 凝结初态
  droplet.setCondense(0.0);
  assert.ok(droplet.mesh.scale.x < 0.001);

  // 凝结满态
  droplet.setCondense(1.0);
  assert.ok(droplet.mesh.scale.x > 0.009);
  const fullRadius = droplet.mesh.scale.x;
  const fullHeight = droplet.mesh.scale.y;
  assert.ok(Math.abs(fullHeight / fullRadius - 0.45) < 0.05);

  // 慢速渗入过程中态：高度塌缩，底面水平半径向心收缩，清漆消退，粗糙度微升
  droplet.setAbsorb(0.5);
  assert.ok(droplet.mesh.scale.y < fullHeight);
  assert.ok(droplet.mesh.scale.x < fullRadius, 'radius must shrink inwards during absorption');
  assert.ok(droplet.mesh.scale.x > fullRadius * 0.65, 'radius must not collapse completely in mid phase');
  assert.ok(droplet.mesh.material.clearcoat < 1.0);
  assert.ok(droplet.mesh.material.roughness > 0.1);

  // 渗入终态：水平半径收缩至 58.5%（再缩小 10%），高度塌缩至接近 0
  droplet.setAbsorb(1.0);
  assert.ok(Math.abs(droplet.mesh.scale.x / fullRadius - 0.585) < 0.02, 'final radius should converge to ~58.5% of base radius');
  assert.ok(droplet.mesh.scale.y < 0.0001);
  assert.equal(droplet.mesh.material.clearcoat, 0.0);
  assert.ok(droplet.mesh.material.opacity <= 0.01);

  // hide 立即隐藏
  droplet.hide();
  assert.equal(droplet.mesh.visible, false);
});

test('InkDropPipeline drives 3D droplet and hides instantly on stop()', async () => {
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

  const scene = new THREE.Scene();
  const droplet = new InkDroplet3D({ scene, dotDiameter: 24 });
  let dirtyCount = 0;

  const pipeline = new InkDropPipeline({
    config: {
      condenseDuration: 30,
      condenseStay: 20,
      absorbDuration: 30,
      spreadDuration: 40,
    },
    droplet3D: droplet,
    getPosition: () => ({ x: 1100, y: 600 }),
    get3DPosition: () => ({ position: new THREE.Vector3(0.5, 0.12, 0.0), normal: new THREE.Vector3(0, 1, 0) }),
    onDirty: () => { dirtyCount += 1; },
  });

  const settle = (ms) => new Promise((res) => setTimeout(res, ms));

  pipeline.start(0);
  await settle(15);
  // 处于 3D 凝结阶段
  assert.equal(droplet.mesh.visible, true);
  assert.ok(pipeline.hasActiveDrop);

  // 用户突然打字中断：pipeline.stop()
  pipeline.stop();
  assert.equal(droplet.mesh.visible, false, 'stop() must instantly hide 3D droplet');
  assert.equal(pipeline.hasActiveDrop, false, 'stop() must reset active drop');
});
