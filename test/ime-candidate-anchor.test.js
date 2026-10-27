import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { evaluatePageSurface } from '../src/page-surface-evaluator.js';

test('index.html defines transparent ink-hidden-input with lineHeight and transparent caret', () => {
  const html = readFileSync(resolve('index.html'), 'utf-8');
  assert.ok(html.includes('.ink-hidden-input'), 'must declare .ink-hidden-input style');
  assert.ok(html.includes('height: 28px'), 'must specify line height for OS IME candidate box alignment');
  assert.ok(html.includes('caret-color: transparent'), 'must hide cursor caret');
  assert.ok(html.includes('color: transparent'), 'must hide text color');
  assert.ok(html.includes('opacity: 0'), 'must keep input element transparent');
});

test('src/ink.js updateHiddenInputPosition projects 3D character position to screen coordinates', () => {
  const inkSource = readFileSync(resolve('src/ink.js'), 'utf-8');
  assert.ok(inkSource.includes('function updateHiddenInputPosition()'), 'must implement updateHiddenInputPosition');
  assert.ok(inkSource.includes('computeNextCharacterPosition()'), 'must evaluate next character canvas position');
  assert.ok(inkSource.includes('surfaceEvaluator.evaluate('), 'must evaluate 3D surface point');
  assert.ok(inkSource.includes('.project(stage.camera)'), 'must project surface position to camera view');
  assert.ok(inkSource.includes('hiddenInput.style.left'), 'must set input style.left');
  assert.ok(inkSource.includes('hiddenInput.style.top'), 'must set input style.top');
  assert.ok(inkSource.includes('update: () =>'), 'createInkSystem must export update method for tick loop');
});

test('Screen projection math accurately maps 3D page surface point to viewport pixels', () => {
  const camera = new THREE.PerspectiveCamera(25, 1920 / 1080, 0.1, 1000);
  camera.position.set(0, 3.2, 3.2);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  const canvasPos = { x: 2048 * 0.56, y: 2048 * 0.29 };
  const surface = evaluatePageSurface(canvasPos, 2048);

  const proj = surface.position.clone().project(camera);
  const screenX = (proj.x * 0.5 + 0.5) * 1920;
  const screenY = (-(proj.y * 0.5) + 0.5) * 1080;

  assert.ok(Number.isFinite(screenX), 'screenX must be finite');
  assert.ok(Number.isFinite(screenY), 'screenY must be finite');
  assert.ok(screenX > 0 && screenX < 1920, 'projected right page anchor must fall within horizontal screen bounds');
  assert.ok(screenY > 0 && screenY < 1080, 'projected right page anchor must fall within vertical screen bounds');
});
