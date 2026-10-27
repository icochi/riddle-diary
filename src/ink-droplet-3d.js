import * as THREE from 'three';

// 像素与 3D 世界空间尺度的换算系数：
// 2048 贴图右页跨度 1024px 对应 3D 纸张宽度 Lx ≈ 0.995724m
const PIXEL_TO_WORLD = 0.995724 / 1024; // ≈ 0.0009724m per pixel

/**
 * 3D 墨滴组件 (InkDroplet3D)
 *
 * 职责：
 * 1. 维护真实的 3D 半球物理网格 (MeshPhysicalMaterial)；
 * 2. 模拟高表面张力半球水珠的高光、清漆反光 (Clearcoat) 与古墨深邃微透质感；
 * 3. 封装三阶段动效（原位凝结膨起 -> 晶莹定格停留 -> 扁平塌缩吸收）；
 * 4. 支持瞬时隐藏与优雅重置。
 */
export class InkDroplet3D {
  /**
   * @param {Object} options
   * @param {THREE.Scene} [options.scene] 3D 场景
   * @param {number} [options.dotDiameter=24] 2D 基准墨核直径 (px)
   * @param {number} [options.heightRatio=0.45] 扁半球高度与半径比
   */
  constructor({ scene = null, dotDiameter = 24, heightRatio = 0.45 } = {}) {
    this.scene = scene;
    this.dotDiameter = dotDiameter;
    this.heightRatio = heightRatio;
    this.baseRadius = (this.dotDiameter / 2) * PIXEL_TO_WORLD;

    // 半球几何体：极低面数但保证圆滑高光，底部 Y=0 平贴纸面
    this.geometry = new THREE.SphereGeometry(
      1.0,
      24,
      12,
      0,
      Math.PI * 2,
      0,
      Math.PI * 0.5
    );

    // 物理材质：深邃铁胆乌黑，仅响应场景主光源单点高光，剔除复杂环境反射贴图
    this.material = new THREE.MeshPhysicalMaterial({
      name: 'InkDroplet3D_Material',
      color: new THREE.Color(0x0b0704),
      roughness: 0.04,
      metalness: 0.0,
      clearcoat: 1.0,
      clearcoatRoughness: 0.03,
      ior: 1.45,
      envMap: null,
      envMapIntensity: 0.0,
      transparent: true,
      opacity: 1.0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      depthWrite: true,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = false;
    this.mesh.visible = false;

    if (this.scene) {
      this.scene.add(this.mesh);
    }

    this._up = new THREE.Vector3(0, 1, 0);
    this._quat = new THREE.Quaternion();
  }

  /**
   * 动态对齐 2D 墨核的内接正圆半径 (px)
   * @param {number} radiusPx 内接圆像素半径
   */
  setBaseRadius(radiusPx) {
    if (typeof radiusPx === 'number' && radiusPx > 0) {
      this.baseRadius = radiusPx * PIXEL_TO_WORLD;
    }
  }

  /**
   * 将墨珠定位至指定的 3D 世界坐标与表面法线
   * @param {THREE.Vector3} position 纸面世界坐标
   * @param {THREE.Vector3} [normal] 纸面法线向量
   */
  showAt(position, normal = null) {
    if (!position) return;
    this.mesh.position.copy(position);
    if (normal) {
      const n = normal.clone();
      if (n.y < 0) n.negate();
      this._quat.setFromUnitVectors(this._up, n);
      this.mesh.quaternion.copy(this._quat);
      this.mesh.position.addScaledVector(n, 0.00015);
    } else {
      this.mesh.quaternion.identity();
      this.mesh.position.y += 0.00015;
    }
    this.setCondense(0.0);
    this.mesh.visible = true;
  }

  /**
   * 原位凝结膨起动效 (0.0 -> 1.0)
   * @param {number} progress 归一化进度 [0, 1]
   */
  setCondense(progress) {
    const p = THREE.MathUtils.clamp(progress, 0, 1);
    const k = p < 1.0 ? 1 - Math.pow(1 - p, 2.5) : 1.0;
    const r = this.baseRadius * k;
    const h = r * this.heightRatio;
    this.mesh.scale.set(r, h, r);
    this.material.clearcoat = 1.0;
    this.material.roughness = 0.04;
    this.material.opacity = Math.min(1.0, p * 1.5);
  }

  /**
   * 饱满定格停留态
   */
  setStay() {
    const r = this.baseRadius;
    const h = r * this.heightRatio;
    this.mesh.scale.set(r, h, r);
    this.material.clearcoat = 1.0;
    this.material.roughness = 0.04;
    this.material.opacity = 1.0;
  }

  /**
   * 慢速渗入动效 (0.0 -> 1.0)
   * 伴随外围毛细向四周抽吸蔓延，中心 3D 墨珠缓慢平伏沉降并向心收缩至 ~65%
   * 物理失水钝化：清漆高光平滑消退 (1.0 -> 0)，粗糙度微升 (0.04 -> 0.5)
   * @param {number} progress 归一化进度 [0, 1]
   */
  setAbsorb(progress) {
    const p = THREE.MathUtils.clamp(progress, 0, 1);
    // 余弦平滑推进：初期墨珠饱满覆盖，中后期平缓沉降
    const smoothP = 0.5 - 0.5 * Math.cos(p * Math.PI);
    const flatten = Math.pow(1.0 - smoothP, 1.4);
    // 水平半径同步 S 型收缩至 58.5%
    const shrink = 1.0 - 0.415 * smoothP;
    const r = this.baseRadius * shrink;
    const h = this.baseRadius * this.heightRatio * flatten;
    this.mesh.scale.set(r, Math.max(0.00001, h), r);
    this.material.clearcoat = Math.max(0, 1.0 - p);
    this.material.roughness = 0.04 + p * 0.46;
    // 伴随毛细展开与网孔析出，表面立体高光与墨珠透明度平滑向零沉降
    this.material.opacity = Math.max(0, 1.0 - p);
  }

  /**
   * 瞬时隐去并重置状态
   */
  hide() {
    this.mesh.visible = false;
    this.mesh.scale.set(0.00001, 0.00001, 0.00001);
    this.material.clearcoat = 1.0;
    this.material.roughness = 0.04;
    this.material.opacity = 1.0;
  }

  /**
   * 销毁几何与材质
   */
  dispose() {
    this.hide();
    if (this.mesh.parent) {
      this.mesh.parent.remove(this.mesh);
    }
    this.geometry.dispose();
    this.material.dispose();
  }
}
