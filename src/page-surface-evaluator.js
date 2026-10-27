import * as THREE from 'three';

// 右页物理曲面展开点查找表：[pageUvX, worldX, worldY]（严格对齐当前烘焙模型的真实展开几何，消除非线性拱弧偏差）
export const PAGE_CURVE_TABLE = [
  [0, 0.014707, 0.084489], [0.00098, 0.015236, 0.085338], [0.003919, 0.016848, 0.087869],
  [0.008814, 0.019621, 0.092035], [0.015668, 0.023696, 0.09775], [0.024479, 0.029279, 0.10487],
  [0.035249, 0.036659, 0.11317], [0.047977, 0.046214, 0.122306], [0.062663, 0.058401, 0.131757],
  [0.079307, 0.073681, 0.140808], [0.09791, 0.092335, 0.148627], [0.11847, 0.114239, 0.154545],
  [0.140989, 0.13887, 0.158346], [0.165466, 0.165635, 0.160197], [0.191901, 0.194098, 0.160459],
  [0.220294, 0.224117, 0.159313], [0.250645, 0.255859, 0.156973], [0.282954, 0.290092, 0.153613],
  [0.317222, 0.325983, 0.149333], [0.353448, 0.363549, 0.144139], [0.391631, 0.402822, 0.137809],
  [0.431773, 0.443791, 0.13034], [0.473874, 0.486427, 0.122086], [0.517932, 0.530737, 0.113459],
  [0.563948, 0.57676, 0.104974], [0.611923, 0.624556, 0.096898], [0.661856, 0.674192, 0.089651],
  [0.713746, 0.725726, 0.083394], [0.767595, 0.779208, 0.078279], [0.823403, 0.834664, 0.074222],
  [0.881168, 0.892104, 0.071106], [0.940891, 0.951522, 0.068589], [1, 1.010263, 0.066208],
];

// 左页物理曲面展开点查找表：[pageUvX, worldX, worldY]
export const LEFT_PAGE_CURVE_TABLE = [
  [0, 0.014466, 0.082544], [0.000978, 0.013559, 0.082938], [0.003913, 0.010835, 0.084113],
  [0.008802, 0.006279, 0.086043], [0.015645, -0.000128, 0.088689], [0.024444, -0.008417, 0.092249],
  [0.035199, -0.018627, 0.096422], [0.047909, -0.030803, 0.101076], [0.062574, -0.044998, 0.106036],
  [0.079194, -0.061259, 0.111087], [0.09777, -0.07961, 0.116004], [0.118301, -0.100021, 0.12063],
  [0.140788, -0.122402, 0.124924], [0.16523, -0.14665, 0.128916], [0.191627, -0.172673, 0.132655],
  [0.219979, -0.20044, 0.136129], [0.250287, -0.229969, 0.139326], [0.282551, -0.261714, 0.142219],
  [0.316769, -0.296105, 0.14476], [0.352943, -0.332503, 0.146877], [0.391072, -0.370916, 0.148443],
  [0.431157, -0.411344, 0.149377], [0.473197, -0.453767, 0.149679], [0.517193, -0.498172, 0.149358],
  [0.563143, -0.544542, 0.148441], [0.611049, -0.592871, 0.1469], [0.660911, -0.643147, 0.144734],
  [0.712728, -0.695369, 0.141882], [0.7665, -0.749531, 0.138276], [0.822227, -0.805631, 0.133791],
  [0.87991, -0.863662, 0.128289], [0.939548, -0.923617, 0.121575], [1, -0.984337, 0.113634],
];

// 日记本中央装订中缝基准 X 坐标 (左右展开页曲面原点平均值 ~0.01458m)
export const BOOK_SEAM_X = (PAGE_CURVE_TABLE[0][1] + LEFT_PAGE_CURVE_TABLE[0][1]) / 2;

/**
 * 纯几何函数：基于查找表与双线性插值求值展开书页曲面坐标与表面法线
 * @param {{ x: number, y: number }} canvasPos 2D 画布像素坐标
 * @param {number} [texSize=2048] 画布尺寸
 * @returns {{ position: THREE.Vector3, normal: THREE.Vector3 }}
 */
export function evaluatePageSurface(canvasPos, texSize = 2048) {
  const texU = canvasPos.x / texSize;
  const texV = canvasPos.y / texSize;
  const isLeftPage = texU < 0.5;
  const table = isLeftPage ? LEFT_PAGE_CURVE_TABLE : PAGE_CURVE_TABLE;
  // 着色器在俯视观察展开页时 !gl_FrontFacing 为 true，经过背面翻转后，右页贴图采样实际对应的网格原生 uv.x 为 (texU - 0.5) * 2.0
  const meshUvX = THREE.MathUtils.clamp(isLeftPage ? 1.0 - texU * 2.0 : (texU - 0.5) * 2.0, 0, 1);
  const z = (texV - 0.5) * 2.0;

  let i = 0;
  while (i < table.length - 1 && table[i + 1][0] <= meshUvX) {
    i++;
  }
  const s0 = table[i];
  const s1 = table[Math.min(i + 1, table.length - 1)];
  const du = s1[0] - s0[0];
  const t = du > 1e-6 ? (meshUvX - s0[0]) / du : 0;
  const x = s0[1] + t * (s1[1] - s0[1]);
  const y = s0[2] + t * (s1[2] - s0[2]);

  const dx = s1[1] - s0[1];
  const dy = s1[2] - s0[2];
  const slope = Math.abs(dx) > 1e-6 ? dy / dx : 0;
  const normal = new THREE.Vector3(-slope, 1, 0).normalize();
  return {
    position: new THREE.Vector3(x, y, z),
    normal,
  };
}

/**
 * 书页立体曲面求值器 (PageSurfaceEvaluator)
 *
 * 领域深模块：
 * 1. 隐藏左右页高精度物理网格展开查找表 (PAGE_CURVE_TABLE / LEFT_PAGE_CURVE_TABLE)；
 * 2. 封装双线性插值、表面切线与解析法线解算；
 * 3. 封装向下投射 Raycaster 对真实物理网格穿透进行微米级校正；
 * 4. 外部仅通过 evaluate(canvasPos) 与 setBookMeshes(meshes) 小接口驱动。
 */
export class PageSurfaceEvaluator {
  /**
   * @param {Object} [options]
   * @param {number} [options.texSize=2048] 贴图分辨率
   * @param {Array<THREE.Mesh>} [options.bookMeshes=[]] 可穿透检测的网格数组
   */
  constructor({ texSize = 2048, bookMeshes = [] } = {}) {
    this.texSize = texSize;
    this.bookMeshes = bookMeshes || [];
    this.raycaster = new THREE.Raycaster();
    this.downVector = new THREE.Vector3(0, -1, 0);
    this._lastCanvasX = -9999;
    this._lastCanvasY = -9999;
    this._cachedResult = null;
  }

  setBookMeshes(meshes) {
    this.bookMeshes = meshes || [];
    this._lastCanvasX = -9999;
    this._lastCanvasY = -9999;
    this._cachedResult = null;
  }

  /**
   * 计算指定 2D 贴图像素坐标对应的 3D 纸面物理坐标与表面法线
   * @param {{ x: number, y: number }} canvasPos 贴图像素坐标
   * @returns {{ position: THREE.Vector3, normal: THREE.Vector3 }}
   */
  evaluate(canvasPos) {
    if (
      canvasPos &&
      canvasPos.x === this._lastCanvasX &&
      canvasPos.y === this._lastCanvasY &&
      this._cachedResult
    ) {
      return this._cachedResult;
    }

    const surf = evaluatePageSurface(canvasPos, this.texSize);
    let result = surf;
    if (this.bookMeshes.length > 0) {
      this.raycaster.set(new THREE.Vector3(surf.position.x, 1.0, surf.position.z), this.downVector);
      const hits = this.raycaster.intersectObjects(this.bookMeshes, true);
      if (hits.length > 0) {
        result = {
          position: hits[0].point,
          normal: hits[0].face ? hits[0].face.normal : surf.normal,
        };
      }
    }

    if (canvasPos) {
      this._lastCanvasX = canvasPos.x;
      this._lastCanvasY = canvasPos.y;
      this._cachedResult = result;
    }
    return result;
  }
}
