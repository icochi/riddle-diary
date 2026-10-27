import * as THREE from 'three';

// 汤姆·里德尔日记本护角材质：古董磨损黄铜（Aged & Worn Antique Brass）
// 1. 基于模型未变形状态的 Rest-pose 固有坐标（vCornerRestPos），100%跟随网格动画无游泳
// 2. 彻底破除对称：解构几何对称，引入非对称局部空间与 3D 分形磨损场
// 3. 区分上下护角：为顶护角与底护角注入独立随机种子与差异化物理做旧特征
// 4. 纯正古董黄铜体系：无绿锈，自然深黑褐色氧化皮、温润古铜本体与抛光金黄磨损高光

const CORNER_GLSL = /* glsl */ `
varying vec3 vCornerRestPos;
varying vec2 vCornerUv;

// 3D 快速伪随机与分形噪声（平滑平方插值，杜绝格子伪影）
float cornerHash3D(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float cornerNoise3D(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  // 五次平滑曲线，消除导数突变
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(
    mix(
      mix(cornerHash3D(i + vec3(0.0, 0.0, 0.0)), cornerHash3D(i + vec3(1.0, 0.0, 0.0)), f.x),
      mix(cornerHash3D(i + vec3(0.0, 1.0, 0.0)), cornerHash3D(i + vec3(1.0, 1.0, 0.0)), f.x),
      f.y
    ),
    mix(
      mix(cornerHash3D(i + vec3(0.0, 0.0, 1.0)), cornerHash3D(i + vec3(1.0, 0.0, 1.0)), f.x),
      mix(cornerHash3D(i + vec3(0.0, 1.0, 1.0)), cornerHash3D(i + vec3(1.0, 1.0, 1.0)), f.x),
      f.y
    ),
    f.z
  );
}

float cornerFbm3D(vec3 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 3; i++) {
    if (i >= octaves) break;
    sum += amp * cornerNoise3D(p);
    p = p * 2.05 + vec3(1.7, 9.2, 5.3);
    amp *= 0.5;
  }
  return sum;
}
`;

export function createCornerMaterial(options = {}) {
  const envMap = options instanceof THREE.Texture ? options : options?.envMap ?? null;
  const envMapIntensity = options?.envMapIntensity ?? 0.08;
  const mat = new THREE.MeshStandardMaterial({
    name: 'DiaryCorner',
    color: new THREE.Color(0x38281a),
    roughness: 0.45,
    metalness: 0.92,
    envMap,
    envMapIntensity,
    side: THREE.DoubleSide,
  });

  mat.onBeforeCompile = (shader) => {
    // 顶点着色器：在 morph 变形之前记录静态基础位置属性，杜绝动画时的纹理游泳
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      /* glsl */ `
      #include <common>
      varying vec3 vCornerRestPos;
      varying vec2 vCornerUv;
      `
    );

    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      /* glsl */ `
      #include <uv_vertex>
      vCornerRestPos = position;
      vCornerUv = uv;
      `
    );

    // 片元着色器：非对称磨损、独立护角特征与微观凹凸
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      /* glsl */ `
      #include <common>
      ${CORNER_GLSL}
      `
    );

    // 1. 微观法线扰动：温和细腻的锻造微不平整感，彻底避免任何条纹伪影
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      /* glsl */ `
      #include <normal_fragment_maps>

      bool isTop_n = (vCornerRestPos.z > 0.0);
      vec3 seed_n = isTop_n ? vec3(12.3, 45.6, 78.9) : vec3(89.1, 34.2, 56.7);
      vec3 pBump = vCornerRestPos * 75.0 + seed_n;

      float b1 = cornerNoise3D(pBump);
      float b2 = cornerNoise3D(pBump * 2.0);
      float bumpH = (b1 * 0.7 + b2 * 0.3 - 0.5) * 0.0012;

      vec3 q0 = dFdx(vViewPosition);
      vec3 q1 = dFdy(vViewPosition);
      vec3 surfGrad = dFdx(bumpH) * cross(q1, normal) + dFdy(bumpH) * cross(normal, q0);
      normal = normalize(normal - surfGrad * 12.0);
      `
    );

    // 2. 漫反射颜色：彻底破除对称、区分上下角、构建层次黄铜色彩
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      /* glsl */ `
      #include <color_fragment>

      // 1) 护角身份识别（顶角 vs 底角）
      bool isTop = (vCornerRestPos.z > 0.0);
      // 为两个护角分配完全不同的采样相位与旋转偏移
      vec3 cornerSeed = isTop ? vec3(0.0) : vec3(47.2, 83.9, 131.5);

      // 2) 非对称局部空间坐标计算（以各自最外凸尖角为原点 (0,0)）
      // X 轴：外尖角向封面内侧延伸 [0, 1]
      // Z 轴：外尖角沿书本上下边沿向书脊延伸 [0, 1]
      float lx = clamp((vCornerRestPos.x - (-1.0164)) / 0.21365, 0.0, 1.0);
      float lz = isTop 
        ? clamp((0.72351 - vCornerRestPos.z) / 0.21365, 0.0, 1.0)
        : clamp((vCornerRestPos.z - (-0.72351)) / 0.21365, 0.0, 1.0);
      vec2 localPos = vec2(lx, lz);
      float distToTip = length(localPos);

      // 3) 几何曲率与浮雕脊线检测
      vec3 dNx = dFdx(vNormal);
      vec3 dNy = dFdy(vNormal);
      float curvature = length(dNx) + length(dNy);
      float edgeMask = smoothstep(0.06, 0.34, curvature);

      // 4) 空间 3D 非对称磨损场（多频噪声叠加，无镜像）
      vec3 pMacro = (vCornerRestPos + cornerSeed) * 45.0;
      vec3 pMid = (vCornerRestPos + cornerSeed) * 95.0;
      float macroFbm = cornerFbm3D(pMacro, 3);
      float midNoise = cornerNoise3D(pMid);

      // 外尖角与日记本外缘摩擦最频繁，磨损概率高
      float tipWear = (1.0 - smoothstep(0.0, 0.85, distToTip)) * 0.50;
      // 方向性非对称：破除沿对角线的平衡，制造单侧偏向磨损
      float directionalAsymmetry = (localPos.x * 1.4 - localPos.y) * 0.24;

      // 宏观磨损几率场
      float wearField = clamp(macroFbm * 0.65 + tipWear + directionalAsymmetry, 0.0, 1.0);

      // 5) 突棱磨损调制：脊线磨损被宏观场打断，消除“四角均匀发亮”的机械感
      float ridgeWear = edgeMask * smoothstep(0.18, 0.60, wearField + midNoise * 0.28);
      // 平坦表面的摩擦露铜高光
      float flatWear = smoothstep(0.48, 0.85, wearField) * 0.55;
      float wear = clamp(ridgeWear * 1.35 + flatWear, 0.0, 1.0);

      // 6) 氧化物与暗褐色包浆沉积：星形深处、小圆孔内侧及背侧平坦面
      float tarnishNoise = cornerFbm3D(pMid + vec3(9.1, 14.3, 21.7), 3);
      // 凹槽与背摩擦处沉积深色氧化皮
      float tarnish = clamp((1.0 - wear * 0.90) * (tarnishNoise * 0.65 + (1.0 - edgeMask) * 0.35), 0.0, 1.0);

      // 7) 纯正黄铜色彩体系（绝无绿色）：
      // - 深焦黑褐色氧化皮（Deep Tarnish Patina，凹处积垢）
      vec3 cDarkTarnish = vec3(0.11, 0.075, 0.045);
      // - 古董黄铜本体色（Aged Antique Brass，温润沉稳）
      vec3 cAgedBrass = vec3(0.56, 0.41, 0.22);
      // - 抛光磨损高光（Polished Worn Brass，纯正明亮金属金）
      vec3 cPolishedBrass = vec3(0.92, 0.77, 0.44);

      // 双阶梯层次混合
      vec3 brass = mix(cAgedBrass, cDarkTarnish, tarnish * 0.85);
      brass = mix(brass, cPolishedBrass, wear);

      diffuseColor.rgb = brass;
      `
    );

    // 3. 粗糙度：磨损抛光处低（高光清晰明亮），氧化皮处高（哑光）
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      /* glsl */ `
      #include <roughnessmap_fragment>

      bool isTop_r = (vCornerRestPos.z > 0.0);
      vec3 cornerSeed_r = isTop_r ? vec3(0.0) : vec3(47.2, 83.9, 131.5);

      float lx_r = clamp((vCornerRestPos.x - (-1.0164)) / 0.21365, 0.0, 1.0);
      float lz_r = isTop_r 
        ? clamp((0.72351 - vCornerRestPos.z) / 0.21365, 0.0, 1.0)
        : clamp((vCornerRestPos.z - (-0.72351)) / 0.21365, 0.0, 1.0);
      vec2 localPos_r = vec2(lx_r, lz_r);
      float distToTip_r = length(localPos_r);

      vec3 dNx_r = dFdx(vNormal);
      vec3 dNy_r = dFdy(vNormal);
      float curvature_r = length(dNx_r) + length(dNy_r);
      float edgeMask_r = smoothstep(0.06, 0.34, curvature_r);

      vec3 pMacro_r = (vCornerRestPos + cornerSeed_r) * 45.0;
      vec3 pMid_r = (vCornerRestPos + cornerSeed_r) * 95.0;
      float macroFbm_r = cornerFbm3D(pMacro_r, 3);
      float midNoise_r = cornerNoise3D(pMid_r);

      float tipWear_r = (1.0 - smoothstep(0.0, 0.85, distToTip_r)) * 0.50;
      float directionalAsymmetry_r = (localPos_r.x * 1.4 - localPos_r.y) * 0.24;
      float wearField_r = clamp(macroFbm_r * 0.65 + tipWear_r + directionalAsymmetry_r, 0.0, 1.0);

      float ridgeWear_r = edgeMask_r * smoothstep(0.18, 0.60, wearField_r + midNoise_r * 0.28);
      float flatWear_r = smoothstep(0.48, 0.85, wearField_r) * 0.55;
      float wear_r = clamp(ridgeWear_r * 1.35 + flatWear_r, 0.0, 1.0);

      float tarnishNoise_r = cornerFbm3D(pMid_r + vec3(9.1, 14.3, 21.7), 3);
      float tarnish_r = clamp((1.0 - wear_r * 0.90) * (tarnishNoise_r * 0.65 + (1.0 - edgeMask_r) * 0.35), 0.0, 1.0);

      float rTarnish = 0.72;
      float rBody = 0.40;
      float rPolished = 0.18;
      float baseR = mix(rBody, rTarnish, tarnish_r);
      roughnessFactor = mix(baseR, rPolished, wear_r);
      `
    );

    // 4. 金属度：磨损抛光显露纯金属高反射，氧化皮略有漫射
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <metalnessmap_fragment>',
      /* glsl */ `
      #include <metalnessmap_fragment>

      bool isTop_m = (vCornerRestPos.z > 0.0);
      vec3 cornerSeed_m = isTop_m ? vec3(0.0) : vec3(47.2, 83.9, 131.5);

      float lx_m = clamp((vCornerRestPos.x - (-1.0164)) / 0.21365, 0.0, 1.0);
      float lz_m = isTop_m 
        ? clamp((0.72351 - vCornerRestPos.z) / 0.21365, 0.0, 1.0)
        : clamp((vCornerRestPos.z - (-0.72351)) / 0.21365, 0.0, 1.0);
      vec2 localPos_m = vec2(lx_m, lz_m);
      float distToTip_m = length(localPos_m);

      vec3 dNx_m = dFdx(vNormal);
      vec3 dNy_m = dFdy(vNormal);
      float curvature_m = length(dNx_m) + length(dNy_m);
      float edgeMask_m = smoothstep(0.06, 0.34, curvature_m);

      vec3 pMacro_m = (vCornerRestPos + cornerSeed_m) * 45.0;
      vec3 pMid_m = (vCornerRestPos + cornerSeed_m) * 95.0;
      float macroFbm_m = cornerFbm3D(pMacro_m, 3);
      float midNoise_m = cornerNoise3D(pMid_m);

      float tipWear_m = (1.0 - smoothstep(0.0, 0.85, distToTip_m)) * 0.50;
      float directionalAsymmetry_m = (localPos_m.x * 1.4 - localPos_m.y) * 0.24;
      float wearField_m = clamp(macroFbm_m * 0.65 + tipWear_m + directionalAsymmetry_m, 0.0, 1.0);

      float ridgeWear_m = edgeMask_m * smoothstep(0.18, 0.60, wearField_m + midNoise_m * 0.28);
      float flatWear_m = smoothstep(0.48, 0.85, wearField_m) * 0.55;
      float wear_m = clamp(ridgeWear_m * 1.35 + flatWear_m, 0.0, 1.0);

      metalnessFactor = mix(0.88, 0.98, wear_m);
      `
    );
  };

  return mat;
}

