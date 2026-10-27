import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { SingleLeafTurn } from '../src/single-leaf.js';
import { PAGE_CURVE_TABLE, LEFT_PAGE_CURVE_TABLE } from '../src/page-surface-evaluator.js';

async function loadTestLeafMesh() {
  const buf = fs.readFileSync('public/assets/single-leaf.glb');
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.parse(arrayBuffer, '', (gltf) => {
      let leafMesh = null;
      gltf.scene.traverse((child) => {
        if (child.isMesh) leafMesh = child;
      });
      resolve(leafMesh);
    }, reject);
  });
}

test('单页从右往左翻页时，旋转铰链轴必须始终精准对齐日记本装订中缝', async () => {
  const mesh = await loadTestLeafMesh();
  assert.ok(mesh, '单页网格应成功加载');

  const leaf = new SingleLeafTurn({ mesh, material: {} });

  // 日记本中央中缝基准坐标 (左右页展开曲面原点平均值)
  const bookSeamX = (PAGE_CURVE_TABLE[0][1] + LEFT_PAGE_CURVE_TABLE[0][1]) / 2; // ~0.01431m

  // 识别原始单页模型上的装订中缝顶点（Target 0 中 X 最靠右的内缘点）
  const posAttr = mesh.geometry.attributes.position;
  const morphs = mesh.geometry.morphAttributes.position;
  const spineVertexIndices = [];
  for (let i = 0; i < posAttr.count; i++) {
    const x0 = posAttr.getX(i) + morphs[0].getX(i);
    if (x0 > 0.01) {
      spineVertexIndices.push(i);
    }
  }
  assert.ok(spineVertexIndices.length > 0, '应识别到装订脊柱边缘顶点');

  // 1. 验证前向翻页 (forward, 左向右): 轴自然贴合中缝
  leaf.play({ direction: 'forward' });
  mesh.updateMatrixWorld(true);
  for (const prog of [0.0, 0.5, 1.0]) {
    leaf.setMorphProgress(prog);
    for (const vIdx of spineVertexIndices) {
      const targetIdx = prog === 0.0 ? 0 : prog === 1.0 ? 8 : 4;
      const localX = posAttr.getX(vIdx) + morphs[targetIdx].getX(vIdx);
      const localY = posAttr.getY(vIdx) + morphs[targetIdx].getY(vIdx);
      const localZ = posAttr.getZ(vIdx) + morphs[targetIdx].getZ(vIdx);
      const worldV = new THREE.Vector3(localX, localY, localZ).applyMatrix4(mesh.matrixWorld);
      assert.ok(
        Math.abs(worldV.x - bookSeamX) < 0.005,
        `Forward progress ${prog} 轴心偏差应小于 5mm，实际偏差: ${Math.abs(worldV.x - bookSeamX)}m`
      );
    }
  }
  leaf.stop();

  // 2. 验证反向翻页 (backward, 从右往左): 轴也必须精准贴合日记本装订中缝
  leaf.play({ direction: 'backward' });
  mesh.updateMatrixWorld(true);
  for (const prog of [0.0, 0.5, 1.0]) {
    leaf.setMorphProgress(prog);
    for (const vIdx of spineVertexIndices) {
      const targetIdx = prog === 0.0 ? 0 : prog === 1.0 ? 8 : 4;
      const localX = posAttr.getX(vIdx) + morphs[targetIdx].getX(vIdx);
      const localY = posAttr.getY(vIdx) + morphs[targetIdx].getY(vIdx);
      const localZ = posAttr.getZ(vIdx) + morphs[targetIdx].getZ(vIdx);
      const worldV = new THREE.Vector3(localX, localY, localZ).applyMatrix4(mesh.matrixWorld);
      assert.ok(
        Math.abs(worldV.x - bookSeamX) < 0.005,
        `Backward progress ${prog} 轴心偏离中缝！bookSeamX=${bookSeamX.toFixed(4)}, worldX=${worldV.x.toFixed(4)}, 偏差=${Math.abs(worldV.x - bookSeamX).toFixed(4)}m`
      );
    }
  }
});
