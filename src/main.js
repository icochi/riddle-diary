import * as THREE from 'three';
import { createStage, loadDesktop, createContactShadow } from './scene.js';
import { loadBook } from './book.js';
import { QuillFollowRig, loadInkBottle, loadQuill } from './quill.js';
import { DURATION, LAST_PAGE, keyAt, pageOf, timeFor, timeOfKey, BookPlayback } from './turn.js';
import { createInkSystem } from './ink.js';
import { loadSingleLeaf } from './single-leaf.js';
import { CameraDirector } from './camera-director.js';
import { SceneInteractionDispatcher } from './scene-interaction-dispatcher.js';

const params = new URLSearchParams(location.search);
// ?page=N 按页定格、?still=1 停住过渡、?view=browse|seam|headon 强制取景
const still = params.has('still');
const forcedView = ['browse', 'seam', 'headon'].includes(params.get('view')) ? params.get('view') : null;
const startPage = params.has('page') ? Number(params.get('page')) : 0;

const stage = createStage(document.body);
const inkSystem = createInkSystem(stage);
const [book, desktop, inkBottle, quill] = await Promise.all([
  loadBook('/assets/diary-book.glb', {
    envMap: stage.darkEnvMap,
    inkTexture: inkSystem.texture,
    textDissolve: inkSystem.textDissolve,
    leftTextDissolve: inkSystem.leftTextDissolve,
    leftEmergingYRange: inkSystem.leftEmergingYRange,
    leftHoverBox: inkSystem.leftHoverBox,
    leftHoverProgress: inkSystem.leftHoverProgress,
    leftHoverMode: inkSystem.leftHoverMode,
  }),
  loadDesktop(stage.ground),
  loadInkBottle('/assets/ink-bottle.glb', { envMap: stage.darkEnvMap }),
  loadQuill('/assets/quill.glb'),
]);
stage.scene.add(book.group);
inkSystem.setBookMeshes(book.pickableMeshes);

// 加载单页翻页动画资产，复用 book.pages 真实做旧内页着色器
const singleLeaf = await loadSingleLeaf('/assets/single-leaf.glb', book.pages);
stage.scene.add(singleLeaf.mesh);
// 消除 2mm 虚浮悬空缝隙，让书本真实接地
stage.ground.position.y = book.minY;

// 配置墨水瓶：缩放匹配真实桌面比例 (0.003)，摆放在笔记本左下角并旋转 180 度 (瓶塞在瓶身左侧)
inkBottle.group.scale.setScalar(0.003);
inkBottle.group.position.set(-1.30, book.minY, 0.52);
inkBottle.group.rotation.y = Math.PI;
stage.scene.add(inkBottle.group);

// 配置羽毛笔：缩放与墨水瓶同为 0.003，交由导轨系统统一调度
quill.group.scale.setScalar(0.003);
stage.scene.add(quill.group);

const quillRig = new QuillFollowRig({
  group: quill.group,
  camera: stage.camera,
  domElement: stage.renderer.domElement,
  bookMeshes: book.pickableMeshes,
  bottleTransform: {
    position: inkBottle.group.position,
    rotationY: inkBottle.group.rotation.y,
  },
  paperY: 0.12,
  groundY: book.minY,
});

const contactShadow = createContactShadow();
contactShadow.position.set(-0.493, book.minY + 0.0003, 0);
stage.scene.add(contactShadow);

// 翻页时序与状态调度深模块
const playback = new BookPlayback({ startPage, still });

const cameraDirector = new CameraDirector({
  camera: stage.camera,
  forcedView,
});

let wasFullyOpen = false;
function show(key, page = pageOf(key)) {
  book.setPose(key, page);
  cameraDirector.applyPose(page);
  // 接触阴影动态跟随书本展开位置与宽度（合上态偏左 -0.493，翻开居中 0.0 并展宽）
  const k = Math.min(Math.max(page / LAST_PAGE, 0), 1);
  contactShadow.position.x = -0.493 * (1 - k);
  contactShadow.scale.x = 1.0 + k * 0.95;

  // 当日记完全展开至最后一页（第 12 页）且正对视角时激活墨水书写系统与羽毛笔跟随
  const isFullyOpen = page >= LAST_PAGE - 0.05;
  inkSystem.setEnabled(isFullyOpen);
  quillRig.setActive(isFullyOpen);
  if (!isFullyOpen && (singleLeaf.isPlaying || singleLeaf.mesh.visible)) {
    singleLeaf.stop();
  }

  // 翻开日记展开落定（由未翻开 -> 完全翻开）时，先演播一次 SVG 开场消融动画
  if (isFullyOpen && !wasFullyOpen) {
    wasFullyOpen = true;
    inkSystem.playOpeningSvgDissolve();
  } else if (!isFullyOpen) {
    wasFullyOpen = false;
    inkSystem.cancelOpeningSvgDissolve();
  }
}

const canvas = stage.renderer.domElement;

const closeBook = () => {
  if (playback.close()) {
    inkSystem.finishSessionReset();
    inkSystem.blur();
    inkSystem.exitReplay(true);
    cameraDirector.releaseSeamView();
    quillRig.releaseBottleHover();
    if (singleLeaf.isPlaying || singleLeaf.mesh.visible) {
      singleLeaf.stop();
    }
  }
};

// 挂接转场全生命周期钩子：
// 1. 消融与翻页开始时：锁定中缝对齐视角，羽毛笔悬停在墨水瓶上方待命；
// 2. 单页翻页落定、开始回顾历史消息或复显时：机位平滑切回正对俯视 (Head-on view)，方便用户正对阅览回放；
// 3. 演播全部结束：释放机位与羽毛笔锁定，恢复鼠标悬停与书写交互。
inkSystem.onTransitionStart(() => {
  cameraDirector.lockSeamView();
  quillRig.hoverOverBottle();
});

inkSystem.onLeafSettled(() => {
  cameraDirector.lockHeadonView();
});

inkSystem.onTransitionEnd(() => {
  quillRig.releaseBottleHover();
  cameraDirector.releaseSeamView();
});

// 注入单页翻页执行器，供新建 session 与切换 session 统一复用
const playLeafTransition = ({ direction = 'forward' } = {}, done) => {
  singleLeaf.play({
    direction,
    onComplete: () => {
      done();
    },
  });
};
inkSystem.setPlayLeaf(playLeafTransition);

// 场景物理拾取与交互仲裁深模块 (SceneInteractionDispatcher)
const interactionDispatcher = new SceneInteractionDispatcher({
  camera: stage.camera,
  targets: {
    bottleObjects: inkBottle.group,
    quillObjects: quill.group,
    bookObjects: book.pickableMeshes,
  },
  stateQuery: {
    isFullyOpen: () => playback.isFullyOpen,
    isQuillInBottle: () => quillRig.isInBottle,
    isHoveringBottle: () => quillRig.isHoveringBottle(),
    isSessionResetting: () => inkSystem.isSessionResetting(),
  },
  actions: {
    onBottleClick: () => {
      // 换页复显：点瓶帧纸面就开始吸干，蘸墨落定只负责放行换纸那一环
      const started = inkSystem.beginSessionReset({
        playLeaf: playLeafTransition,
      });
      if (!started) return;
      quillRig.triggerDoubleDip(() => inkSystem.signalQuillSettled());
    },
    onBookClick: (hit) => {
      if (playback.isFullyOpen) {
        inkSystem.handleClick(hit);
      } else {
        playback.toggle();
      }
    },
    onOutsideClick: () => {
      closeBook();
    },
    onBookHover: (hit) => {
      inkSystem.handleHover(hit);
    },
  },
});

canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect();
  interactionDispatcher.dispatchClick(e.clientX, e.clientY, rect);
});

canvas.addEventListener('pointermove', (e) => {
  const rect = canvas.getBoundingClientRect();
  interactionDispatcher.dispatchPointerMove(e.clientX, e.clientY, rect);
});

canvas.addEventListener('pointerleave', () => {
  interactionDispatcher.dispatchPointerLeave();
});

canvas.addEventListener('keydown', (e) => {
  if (inkSystem.isFocused()) return;
  if (e.key !== ' ' && e.key !== 'Enter') return;
  e.preventDefault();
  playback.toggle();
});

show(playback.key, playback.page);

const frames = [];
let prev = performance.now();
function tick(now) {
  const dt = (now - prev) / 1000;
  frames.push(now - prev);
  if (frames.length > 240) frames.shift();
  const stepState = playback.step(dt);
  if (stepState.changed) {
    show(stepState.key, stepState.page);
  }
  quillRig.update(dt);
  singleLeaf.update(dt);

  // 镜头调度深模块单行驱动（封装完全摊开悬停平滑、四阶段运镜与手动调试覆盖）
  cameraDirector.step(dt, playback.page, playback.isFullyOpen, quillRig.isOverBook);

  inkSystem.update();
  prev = now;
  stage.render();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// 独立运行环境交互端口与开场 SVG 预加载
if (typeof window !== 'undefined') {
  inkSystem.setValidatePort(() => ({ ready: true }));
  inkSystem.setPromptPort((fullPrompt) => '你好哈利波特，我是汤姆·豆包·里德尔。');
  if (inkSystem.preloadOpeningSvg) {
    inkSystem.preloadOpeningSvg('/assets/image.svg');
  }
}

function quantile(sorted, q) {
  return sorted[Math.floor(q * (sorted.length - 1))];
}

// 工单 06 要实测帧率与显存；工单 08 的交互上线后仍用它做量化
window.__diary = {
  stage,
  book,
  desktop,
  inkBottle,
  quill,
  quillRig,
  singleLeaf,
  cameraDirector,
  lights: stage.lights,
  inkSystem,
  playback,
  pace: { DURATION, LAST_PAGE, keyAt, pageOf, timeOfKey, pageAt: (s) => pageOf(keyAt(s)), timeFor },
  get page() {
    return playback.page;
  },
  set page(n) {
    const snap = playback.seekPage(n);
    show(snap.key, snap.page);
  },
  get key() {
    return playback.key;
  },
  // 定格到任意键（含封面补键），供与 Blender 预览帧逐张对比
  set key(n) {
    const snap = playback.seekKey(n);
    show(snap.key, snap.page);
  },
  view: (name) => cameraDirector.jumpView(name, playback.page),
  targets: () => book.targetsInfo,
  stats: () => {
    const s = [...frames].sort((a, b) => a - b);
    const mem = stage.renderer.info.memory;
    return {
      frameMs: { median: quantile(s, 0.5), p95: quantile(s, 0.95), p99: quantile(s, 0.99), max: s.at(-1) },
      fps: { median: Math.round(1000 / quantile(s, 0.5)), p1: Math.round(1000 / quantile(s, 0.99)) },
      drawCalls: stage.renderer.info.render.calls,
      triangles: stage.renderer.info.render.triangles,
      geometries: mem.geometries,
      textures: mem.textures,
      programs: stage.renderer.info.programs.length,
      jsHeapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
      devicePixelRatio: window.devicePixelRatio,
      gl: stage.renderer.getContext().getParameter(
        stage.renderer.getContext().getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL ?? 0x1F01
      ),
    };
  },
  testSvgDissolve: (url, dur) => inkSystem.testRenderSvgDissolve(url, dur),
  playOpeningSvgDissolve: (opts) => inkSystem.playOpeningSvgDissolve(opts),
  cancelOpeningSvgDissolve: () => inkSystem.cancelOpeningSvgDissolve(),
};

window.testSvgDissolve = (url, dur) => inkSystem.testRenderSvgDissolve(url, dur);
window.playOpeningSvgDissolve = (opts) => inkSystem.playOpeningSvgDissolve(opts);
