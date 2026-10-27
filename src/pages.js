import * as THREE from 'three';

// 内页材质：以真实古纸贴图为底，着色器现算泛黄云斑、茶渍做旧、书口焦褐、外圈压暗与独立页序相位。
// 常数逐条抄自 Blender 的 BookPages 节点树（线性色），唯一的改动是把节点树里读不到的
// LeafIndex/LeafOuter 接回导出的页序坐标，让每页有独立相位。
const GLSL = /* glsl */ `
uniform float uAging;
uniform float uOpen;
uniform float uFiber;
uniform sampler2D tPageBaseColor;
uniform sampler2D tPageOrm;
uniform sampler2D tPageNormal;
uniform sampler2D tInkTexture;
uniform float uHasInkTexture;
uniform float uTextDissolve;
uniform float uLeftTextDissolve;
uniform vec2 uLeftEmergingYRange;
uniform vec4 uLeftHoverBox;
uniform float uLeftHoverProgress;
uniform float uLeftHoverMode;
varying vec2 vPageUv;
varying vec2 vPageInfo;

float pageHash(vec2 p) {
	return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453123 );
}

float pageNoise(vec2 p) {
	vec2 g = floor( p ), f = fract( p );
	f = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( pageHash( g ), pageHash( g + vec2( 1.0, 0.0 ) ), f.x ),
		mix( pageHash( g + vec2( 0.0, 1.0 ) ), pageHash( g + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}

// Blender 的 Noise 节点：Factor 大致落在 [0,1]，Detail 折算成倍频数，Distortion 做轻度域扭曲
float pageFbm(vec2 p, float scale, float distort, int octaves) {
	p *= scale;
	p += distort * ( pageNoise( p * 0.6 + 13.7 ) - 0.5 ) * 2.0;
	float sum = 0.0, amp = 0.5, norm = 0.0;
	for ( int i = 0; i < 3; i ++ ) {
		if ( i >= octaves ) break;
		sum += amp * pageNoise( p );
		norm += amp;
		amp *= 0.5;
		p *= 2.0;
	}
	return sum / norm;
}

float gInkCoverage = 0.0;
`;

export function createPageMaterial(textures = {}) {
  const aging = { value: 1.0 };
  const open = { value: 0.0 };
  const textDissolve = textures.textDissolve || { value: 0.0 };
  const leftTextDissolve = textures.leftTextDissolve || { value: 0.0 };
  const leftEmergingYRange = textures.leftEmergingYRange || { value: new THREE.Vector2(-1.0, -1.0) };
  const leftHoverBox = textures.leftHoverBox || { value: new THREE.Vector4(-1.0, -1.0, -1.0, -1.0) };
  const leftHoverProgress = textures.leftHoverProgress || { value: 0.0 };
  const leftHoverMode = textures.leftHoverMode || { value: 0.0 };
  const mat = new THREE.MeshStandardMaterial({ name: 'DiaryPages', roughness: 0.8, side: THREE.DoubleSide });
  mat.userData.aging = aging;
  mat.userData.open = open;
  mat.userData.textDissolve = textDissolve;
  mat.userData.leftTextDissolve = leftTextDissolve;
  mat.userData.leftEmergingYRange = leftEmergingYRange;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uAging = aging;
    shader.uniforms.uOpen = open;
    shader.uniforms.uFiber = { value: 0.0095 };
    shader.uniforms.tPageBaseColor = { value: textures.basecolor || null };
    shader.uniforms.tPageOrm = { value: textures.orm || null };
    shader.uniforms.tPageNormal = { value: textures.normal || null };
    mat.userData.inkTextureUniform = shader.uniforms.tInkTexture = { value: textures.inkTexture || null };
    mat.userData.hasInkTextureUniform = shader.uniforms.uHasInkTexture = { value: textures.inkTexture ? 1.0 : 0.0 };
    mat.userData.textDissolveUniform = shader.uniforms.uTextDissolve = textDissolve;
    mat.userData.leftTextDissolveUniform = shader.uniforms.uLeftTextDissolve = leftTextDissolve;
    mat.userData.leftEmergingYRangeUniform = shader.uniforms.uLeftEmergingYRange = leftEmergingYRange;
    mat.userData.leftHoverBoxUniform = shader.uniforms.uLeftHoverBox = leftHoverBox;
    mat.userData.leftHoverProgressUniform = shader.uniforms.uLeftHoverProgress = leftHoverProgress;
    mat.userData.leftHoverModeUniform = shader.uniforms.uLeftHoverMode = leftHoverMode;

    shader.vertexShader = `
attribute vec2 uv1;
varying vec2 vPageUv;
varying vec2 vPageInfo;
` + shader.vertexShader
      .replace('#include <begin_vertex>', /* glsl */ `
	#include <begin_vertex>
	vPageUv = uv;
	float leafId = uv1.x * 49.0;
	vPageInfo = vec2( leafId, uv1.y );
`)
      .replace('#include <shadowmap_vertex>', /* glsl */ `
#if ( defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS > 0 || NUM_SUN_LIGHT_SHADOWS > 0 || NUM_POINT_LIGHT_SHADOWS > 0 ) ) || ( NUM_SPOT_LIGHT_COORDS > 0 )
	// 零厚度单面网格：法线在翻页后倒置，若沿顶点法线加 normalBias 会将反面推入自遮挡中。
	// 将 shadowWorldNormal 设为 0，完全基于高精度深度比较接收阴影，实现双面平滑受影且零性能开销
	vec3 shadowWorldNormal = vec3( 0.0 );
	vec4 shadowWorldPosition;
#endif
#if defined( USE_SHADOWMAP )
	#if NUM_SUN_LIGHT_SHADOWS > 0
		vSunShadowWorldPosition = vec4( worldPosition.xyz, - mvPosition.z );
		vSunShadowWorldNormal = shadowWorldNormal;
	#endif
	#if NUM_DIR_LIGHT_SHADOWS > 0
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
			shadowWorldPosition = worldPosition;
			vDirectionalShadowCoord[ i ] = directionalShadowMatrix[ i ] * shadowWorldPosition;
		}
		#pragma unroll_loop_end
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_POINT_LIGHT_SHADOWS; i ++ ) {
			shadowWorldPosition = worldPosition;
			vPointShadowCoord[ i ] = pointShadowMatrix[ i ] * shadowWorldPosition;
		}
		#pragma unroll_loop_end
	#endif
#endif
#if NUM_SPOT_LIGHT_COORDS > 0
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SPOT_LIGHT_COORDS; i ++ ) {
		shadowWorldPosition = worldPosition;
		vSpotLightCoord[ i ] = spotLightMatrix[ i ] * shadowWorldPosition;
	}
	#pragma unroll_loop_end
#endif
`);

    shader.fragmentShader = GLSL + shader.fragmentShader
      .replace('#include <color_fragment>', /* glsl */ `
	#include <color_fragment>
	float leafId = vPageInfo.x;

	// 左页（背面 gl_FrontFacing == false）水平翻转，保持左右两页图文均自左向右正向排布
	vec2 pageUv = vPageUv;
	if ( !gl_FrontFacing ) {
		pageUv.x = 1.0 - pageUv.x;
	}

	// 沿书页白银比例 (1 : 1.4142) 对齐，保持物理等比例无拉伸
	vec2 sampleUv = vec2( pageUv.x, pageUv.y * 1.4142 );
	vec4 texColor = texture2D( tPageBaseColor, sampleUv );

	vec2 cp = sampleUv * 3.5 + vec2( fract( leafId * 0.618 ) * 5.3, fract( leafId * 0.754 ) * 4.1 );
	float cloudMid = pageFbm( cp, 4.5, 0.7, 3 );
	float cloud = cloudMid * 0.28 + pageFbm( cp, 1.15, 0.35, 2 );
	float ramp = clamp( ( cloud - 0.30 ) / 0.42, 0.0, 1.0 );

	// 外侧三边（上缘、下缘、书口外缘）做旧晕染衰减场，中缝装订侧不参与
	float distY = min( vPageUv.y, 1.0 - vPageUv.y );
	float distX = 1.0 - vPageUv.x;
	float haloY = 1.0 - smoothstep( 0.02, 0.22, distY );
	float haloX = 1.0 - smoothstep( 0.04, 0.35, distX );
	float outerHalo = max( haloX, haloY * smoothstep( 0.02, 0.15, vPageUv.x ) );

	// 做旧污渍与茶渍衰减色：中心区域仅保留极浅微泛黄 (12%)，外圈呈现深浅起伏的黄色做旧与茶斑
	vec3 lightAged = vec3( 0.81, 0.68, 0.50 ) / vec3( 0.87, 0.849, 0.79 );
	vec3 darkAged  = vec3( 0.50, 0.36, 0.22 ) / vec3( 0.87, 0.849, 0.79 );
	vec3 spotTint  = mix( mix( lightAged, darkAged, outerHalo * 0.85 ), lightAged, ramp );
	vec3 agedTint  = mix( vec3( 1.0 ), spotTint, mix( 0.12, 1.0, outerHalo ) * uAging );

	// 纸张底色：古纸贴图 Albedo 适度调暗并与做旧污渍正片叠底，叠加单页明暗差与外页压暗
	vec3 paper = texColor.rgb * 0.85 * agedTint * mix( 0.95, 1.05, fract( leafId * 0.359 ) ) * mix( 1.0, 0.92, vPageInfo.y * uAging );

	// 上下页缘与书口外缘窄带老化加深 (Edge Aging)，基于真实展开 UV 判定，中缝根部不焦化
	float edgeSide = clamp( ( 0.045 - min( vPageUv.y, 1.0 - vPageUv.y ) ) / 0.045, 0.0, 1.0 );
	float edgeFore = clamp( ( vPageUv.x - 0.90 ) / 0.09, 0.0, 1.0 );
	float edge = max( edgeSide * smoothstep( 0.02, 0.15, vPageUv.x ), edgeFore ) * mix( 0.45, 1.0, cloudMid ) * uAging;
	diffuseColor.rgb = mix( paper, vec3( 0.355, 0.245, 0.135 ), edge );

	// 3D 动态墨水贴图：仅在日记本摊开就绪的最表层页 (左页 leafId ≈ 11，右页 leafId ≈ 10) 正片叠底混合
	gInkCoverage = 0.0;
	if ( uHasInkTexture > 0.5 && leafId >= 9.5 && leafId <= 11.5 ) {
		float isLeftPage = step( 10.5, leafId );
		// 右页 (isLeftPage == 0.0): 中缝向外缘展开，使用 1.0 - pageUv.x * 0.5
		// 左页 (isLeftPage == 1.0): 外缘向中缝展开，使用 (1.0 - pageUv.x) * 0.5 彻底消除左页镜像
		float texU = mix( 1.0 - pageUv.x * 0.5, ( 1.0 - pageUv.x ) * 0.5, isLeftPage );

		// 纵向按物理白银比例 (1 : 1.4142) 与左右双页平分系数校正并居中 (Kv = 1.4142 / 2.0 = 0.7071)
		float texV = ( pageUv.y - 0.5 ) * 0.7071 + 0.5;
		if ( texV >= 0.0 && texV <= 1.0 ) {
			vec2 inkTexUv = vec2( texU, texV );
			vec4 ink = texture2D( tInkTexture, inkTexUv );
			if ( ink.a > 0.005 ) {
				// 1. 骨架中轴中枢与边缘敏感度 (0.0=外缘/薄墨, 1.0=笔画中心骨核)
				float strokeDepth = ink.g > 0.005 ? ink.g : ink.a;
				float edgeSensitivity = 1.0 - smoothstep( 0.20, 0.70, strokeDepth );

				// 2. 羊皮纸纤维微观起伏与高低缝隙阻墨场 (Micro-relief & Fiber Tooth)
				float paperLuma = dot( texColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
				vec2 normUv = sampleUv + vec2( fract( leafId * 0.618 ), fract( leafId * 0.754 ) ) * 0.35;
				vec3 fiberNorm = texture2D( tPageNormal, normUv ).xyz * 2.0 - 1.0;

				// 微观高频纸浆与纸筋纤维噪波
				vec2 microFiberCoord = pageUv * vec2( 340.0, 480.0 );
				float microPulp = pageNoise( microFiberCoord ) * 0.65 + pageNoise( microFiberCoord * 2.2 + 19.3 ) * 0.35;

				// 综合纸纤维阻墨与渗透吸收差：深邃沉淀，凸起处保留细腻飞白咬纸
				float fiberDepth = clamp( ( 0.88 - paperLuma ) * 1.8 + ( fiberNorm.x + fiberNorm.y ) * 0.25 + ( microPulp - 0.5 ) * 0.6, -1.0, 1.0 );
				float fiberTrapping = fiberDepth * ( 0.10 + 0.35 * edgeSensitivity );

				// 有效墨层浓度 (Density) - 提高基底浓度增益，确保笔画主体乌黑饱满
				float density = clamp( strokeDepth * 1.15 + fiberTrapping, 0.0, 1.0 );

				// 3. 双色相铁胆墨水色调渐变 (Iron-Gall Color Transition)
				// 浓处为深邃乌墨色 #0f0a06，凸起/薄处为温润深茶褐色 #2b1c12
				vec3 deepCarbon = vec3( 0.045, 0.030, 0.018 );
				vec3 warmSepia  = vec3( 0.155, 0.102, 0.062 );
				vec3 targetInkColor = mix( warmSepia, deepCarbon, smoothstep( 0.10, 0.55, density ) );

				// 4. 左页（历史索引）岁月氧化风干微调
				if ( isLeftPage > 0.5 ) {
					targetInkColor = mix( targetInkColor, vec3( 0.18, 0.13, 0.09 ), 0.20 );
					density *= 0.92;
				}

				// 5. 左右页文字消融与毛细显影动态计算
				float activeDissolve = 0.0;
				if ( isLeftPage < 0.5 ) {
					activeDissolve = uTextDissolve;
				} else {
					if ( uLeftTextDissolve > 0.001 ) {
						// 仅对落在新增项 Y 范围内的左页墨迹生效；若未指定范围 (YRange.x < 0.0) 则全局生效
						if ( uLeftEmergingYRange.x < 0.0 || ( texV >= uLeftEmergingYRange.x && texV <= uLeftEmergingYRange.y ) ) {
							activeDissolve = max( activeDissolve, uLeftTextDissolve );
						}
					}
				}

				if ( activeDissolve > 0.001 ) {
					float stage = 1.0 - activeDissolve;
					// 笔画收缩位移：从 -0.15 (饱满完全覆盖) 推进到 1.15 (完全收尽)
					float widthCutoff = mix( -0.15, 1.15, smoothstep( 0.05, 0.98, activeDissolve ) );
					// 宽域羽化过渡带：深度消融/显影时过渡带宽度达到 0.45，实现真正的柔和水渍羽化晕散
					float feather = mix( 0.12, 0.45, activeDissolve );
					// 微观纸浆纤维柔和渗透扰动
					float fiberNoise = ( microPulp - 0.5 ) * 0.12 * activeDissolve;
					float widthAlpha = smoothstep( -feather, feather, ( strokeDepth - widthCutoff ) + fiberNoise );

					// 全局柔和不透明度淡化 (缓入快出：前期浓度坚挺不发虚，后期加速淡化融入纸张)
					float opacity = smoothstep( 0.015, 0.80, stage );
					float fiberGrain = 0.92 + 0.08 * microPulp;

					float dissolveAlpha = widthAlpha * opacity * fiberGrain;
					density = clamp( density * dissolveAlpha, 0.0, 1.0 );
					ink.a *= dissolveAlpha;

					// 色相褪色缓入快出：前期保持饱满深邃铁胆墨色，后期加速向浅褐水痕褪色
					vec3 waterStainColor = vec3( 0.32, 0.22, 0.15 );
					targetInkColor = mix( waterStainColor, targetInkColor, smoothstep( 0.08, 0.65, stage ) );
				}

				// 6. 左页 Hover 下划线从左到右运笔划线与擦除裁剪
				if ( isLeftPage > 0.5 && uLeftHoverMode > 0.5 ) {
					if ( texV >= uLeftHoverBox.z && texV <= uLeftHoverBox.w && texU >= uLeftHoverBox.x && texU <= uLeftHoverBox.y ) {
						float tipU = mix( uLeftHoverBox.x, uLeftHoverBox.y, uLeftHoverProgress );
						float strokeFeather = 5.0 / 2048.0;
						if ( uLeftHoverMode < 1.5 ) {
							// 模式 1：从左到右运笔绘制延伸 (texU <= tipU 可见)
							float strokeMask = 1.0 - smoothstep( tipU - strokeFeather, tipU + strokeFeather, texU );
							ink.a *= strokeMask;
						} else {
							// 模式 2：从左到右运笔原路擦除 (texU >= tipU 保留，texU < tipU 擦除)
							float strokeMask = smoothstep( tipU - strokeFeather, tipU + strokeFeather, texU );
							ink.a *= strokeMask;
						}
					}
				}

				// 7. 最终墨层混合与粗糙度覆盖记录 (保持笔画高不透明度，杜绝发虚发淡)
				float effectiveAlpha = ink.a * clamp( 0.90 + 0.10 * density, 0.0, 1.0 );
				if ( effectiveAlpha > 0.005 ) {
					diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * targetInkColor, effectiveAlpha );
					gInkCoverage = effectiveAlpha;
				}
			}
		}
	}
`)
      .replace('#include <roughnessmap_fragment>', /* glsl */ `
	#include <roughnessmap_fragment>
	// 采样真实古纸微观粗糙度
	vec2 pageRoughUV = vec2( vPageUv.x, vPageUv.y * 1.4142 ) + vec2( fract( vPageInfo.x * 0.618 ), fract( vPageInfo.x * 0.754 ) ) * 0.35;
	float paperRough = texture2D( tPageOrm, pageRoughUV ).g;
	roughnessFactor = mix( paperRough * 0.85, paperRough * 1.05, uAging );
	// 干燥铁胆墨水胶质微光泽：浓墨处粗糙度适度下调，在掠射角下展现干涸铁胆墨水独特的微弱蜡质光泽
	roughnessFactor = mix( roughnessFactor, roughnessFactor * 0.82, clamp( gInkCoverage * 1.15, 0.0, 1.0 ) );
`)
      .replace('#include <normal_fragment_begin>', /* glsl */ `
	#include <normal_fragment_begin>
	vec2 pageNormUV = vec2( vPageUv.x, vPageUv.y * 1.4142 ) + vec2( fract( vPageInfo.x * 0.618 ), fract( vPageInfo.x * 0.754 ) ) * 0.35;
	vec3 texNormal = texture2D( tPageNormal, pageNormUV ).xyz * 2.0 - 1.0;
	vec3 tX = normalize( cross( dFdy( vViewPosition ), normal ) );
	vec3 tY = normalize( cross( normal, dFdx( vViewPosition ) ) );
	// 真实古纸纤维微观凹凸法线
	normal = normalize( normal + ( texNormal.x * tX + texNormal.y * tY ) * 0.22 );
`,)
      .replace('#include <dithering_fragment>', /* glsl */ `
	#include <dithering_fragment>
	// 纸张微观纤维掠射角柔和微光 (Paper Sheen)
	vec3 viewDir = normalize( vViewPosition );
	float grazing = pow( 1.0 - max( 0.0, dot( normal, viewDir ) ), 3.5 );
	gl_FragColor.rgb += vec3( 0.10, 0.07, 0.04 ) * grazing;
`);
  };
  return mat;
}
