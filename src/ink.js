import * as THREE from 'three';
import { InkSessionModel } from './ink-session.js';
import { InkRasterizer, computeSkeletonField, wrapTextLines, applyMorphologicalDissolution } from './ink-rasterizer.js';
import { InkDropPipeline, DEFAULT_DROP_CONFIG } from './ink-drop-pipeline.js';
import { InkDroplet3D } from './ink-droplet-3d.js';
import { SessionTransitionSequence, SessionEpoch } from './session-reset.js';
import { ChatInkDirector, DEFAULT_DIRECTOR_CONFIG, calculateAiPageStayMs } from './chat-ink-director.js';
import { InkDissolveDriver } from './ink-dissolve-driver.js';
import { InkTextTransitioner } from './ink-text-transitioner.js';
import { InkInputCoordinator } from './ink-input-coordinator.js';
import { LeftPageHistoryView } from './left-page-history-view.js';
import { SessionEchoPlayback } from './session-echo-playback.js';
import { PageSurfaceEvaluator } from './page-surface-evaluator.js';
import { extractInkFromImageData, bakeSkeletonToGreenChannel } from './svg-ink-pipeline.js';

/**
 * 3D 动态墨水贴图系统 (Dynamic Ink Texture System)
 *
 * 核心架构：
 * 1. 维护 2048x2048 离屏 Canvas，经由 THREE.CanvasTexture 注入 pages.js 内页着色器；
 * 2. 贴图布局：
 *    - 左半部分 (0 <= U < 0.5): 左页历史索引目录，U=0 对应左页中缝，U=0.5 对应左页外缘；
 *    - 右半部分 (0.5 <= U <= 1.0): 右页主书写区，U=0.5 对应右页中缝，U=1.0 对应右页外缘；
 *    - V 方向: V=0 对应书页顶缘，V=1 对应书页底缘。
 * 3. 字体排版、滴墨扩散、文字打字、反向毛细显影与分形消融全部直接光栅化至 Canvas；
 * 4. 彻底移除视口 DOM 叠层与 CSS 3D 投影，文字随内页三维曲面弯曲与光影统一渲染。
 */

export const TEXT_CONFIG = DEFAULT_DIRECTOR_CONFIG;

export const aiPageStayMs = calculateAiPageStayMs;

export function createInkSystem(stage, customConfig = {}) {
  const config = { ...DEFAULT_DROP_CONFIG, ...customConfig };
  const textCfg = { ...TEXT_CONFIG, ...customConfig.textConfig };
  const onSendPrompt = customConfig.onSendPrompt || (async (prompt) => {
    await new Promise((res) => setTimeout(res, textCfg.mockAiDelay));
    return textCfg.mockAiResponse;
  });

  // 1. 创建离屏 2048x2048 画布与 CanvasTexture
  const TEX_SIZE = 2048;
  const canvas = document.createElement('canvas');
  canvas.width = TEX_SIZE;
  canvas.height = TEX_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const texture = new THREE.CanvasTexture(canvas);
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.anisotropy = 1;

  // GPU 着色器消融显影驱动深模块 (InkDissolveDriver)
  const dissolveDriver = new InkDissolveDriver({
    renderPort: {
      onRightPageRedraw: () => redrawRightPage(),
      onFullRedraw: () => redrawFullCanvas(),
    },
  });
  const textDissolve = dissolveDriver.textDissolve;
  const leftTextDissolve = dissolveDriver.leftTextDissolve;
  const leftEmergingYRange = dissolveDriver.leftEmergingYRange;
  const leftHoverBox = { value: new THREE.Vector4(-1.0, -1.0, -1.0, -1.0) };
  const leftHoverProgress = { value: 0.0 };
  const leftHoverMode = { value: 0.0 };

  // 2. 隐藏 input 捕获键盘与中文输入法
  const hiddenInput = document.createElement('input');
  hiddenInput.type = 'text';
  hiddenInput.className = 'ink-hidden-input';
  hiddenInput.autocomplete = 'off';
  hiddenInput.autocapitalize = 'off';
  hiddenInput.spellcheck = false;
  document.body.appendChild(hiddenInput);

  let isEnabled = false;

  // 左右页在 2048 画布上的绝对像素版心范围 (避开装订沟与外缘焦斑，纵向落在纸面约 1/4 ~ 1/3 起始处)
  const LEFT_PAGE = {
    x: TEX_SIZE * 0.08,
    y: TEX_SIZE * 0.29,
    w: TEX_SIZE * 0.36,
    h: TEX_SIZE * 0.45,
  };

  const RIGHT_PAGE = {
    x: TEX_SIZE * 0.56,
    y: TEX_SIZE * 0.29,
    w: TEX_SIZE * 0.36,
    h: TEX_SIZE * 0.45,
  };

  const FONT_RIGHT = {
    family: '"Long Cang", "Georgia", "STKaiti", cursive, serif',
    aiFamily: '"Tangerine", "WangHanZong-ZhongXingShu", "MuYao-SuiXin", "Long Cang", cursive, serif',
    size: 46,
    lineHeight: 72,
  };

  const FONT_LEFT = {
    family: '"Long Cang", "Georgia", "STKaiti", cursive, serif',
    size: 34,
    lineHeight: 52,
  };

  // 墨迹排版与骨架光栅化深模块实例 (右页)
  const rasterizer = new InkRasterizer({
    pageRect: RIGHT_PAGE,
    fontConfig: FONT_RIGHT,
    canvasSize: TEX_SIZE,
  });

  // 左页历史索引视图深模块实例 (左页)
  const leftHistoryView = new LeftPageHistoryView({
    pageRect: LEFT_PAGE,
    fontConfig: FONT_LEFT,
    canvasSize: TEX_SIZE,
  });

  const sessionModel = new InkSessionModel({
    textMeasurer: (text, isAi) => rasterizer.measurePageRanges(text, isAi, ctx),
    historyCapacity: leftHistoryView.capacity,
  });

  const onTypeListeners = [];
  function notifyType() {
    for (const fn of onTypeListeners) {
      try { fn(); } catch (e) { console.error(e); }
    }
  }

  const switchSessionListeners = [];
  const newSessionListeners = [];
  sessionModel.onSessionsChange(() => {
    redrawFullCanvas();
  });

  const dropPhaseListeners = [];
  function notifyDropPhase(phase, meta) {
    for (const fn of dropPhaseListeners) {
      try { fn(phase, meta); } catch (e) { console.error(e); }
    }
  }

  // 右页打字与动画状态
  let currentRenderText = '';
  let textIsAi = false;
  let textAlpha = 1.0;

  // 会话世代：一次换页复显即宣告上一代终结，其排在动画、延时与网络之后的所有演出自行作废
  const sessionEpoch = new SessionEpoch();
  // 原样转发：多塞进来的延时参数要能被 guard() 的 arity 陷阱抓到，而不是在这里悄悄丢掉
  const guard = (...args) => sessionEpoch.guard(...args);


  // 书页立体曲面求值器深模块 (PageSurfaceEvaluator)
  const surfaceEvaluator = new PageSurfaceEvaluator({ texSize: TEX_SIZE });

  function get3DPosition(canvasPos) {
    return surfaceEvaluator.evaluate(canvasPos);
  }

  const droplet3D = stage?.scene
    ? new InkDroplet3D({
        scene: stage.scene,
        dotDiameter: config.dotDiameter,
      })
    : null;

  // 待输入滴墨管线深模块实例
  const dropPipeline = new InkDropPipeline({
    config,
    droplet3D,
    getPosition: () => computeNextCharacterPosition(),
    get3DPosition,
    onDirty: () => redrawFullCanvas(),
    onPhaseChange: (phase, meta) => notifyDropPhase(phase, meta),
  });

  // 对话墨迹周期与演播调度深模块 (ChatInkDirector)
  const chatDirector = new ChatInkDirector({
    sessionModel,
    epoch: sessionEpoch,
    config: textCfg,
    promptPort: onSendPrompt,
    displayPort: {
      dissolveLeftInitialTitle: (duration, done) => textTransitioner.dissolveInitialTitleIfNeeded(sessionModel, duration, done),
      animateTextErosion,
      animateTextEmergence,
      prepareLeftItemEmergence,
      animateLeftItemEmergence,
      setRenderText: (text, isAi) => {
        currentRenderText = text;
        textIsAi = isAi;
        textDissolve.value = 0.0;
        textAlpha = 1.0;
        redrawRightPage();
      },
      redrawCanvas: () => redrawFullCanvas(),
    },
    inputPort: {
      lock: () => {},
      unlock: () => {
        if (isEnabled) focusInput();
      },
      syncDraft: (text, cursor) => {
        hiddenInput.value = text;
        hiddenInput.setSelectionRange(cursor, cursor);
      },
    },
    dropPort: {
      start: (delay) => {
        if (isEnabled) startDropCycle(delay);
      },
      stop: () => stopDropCycle(),
    },
  });

  // 打字与跨页过渡协调深模块 (InkInputCoordinator)
  const inputCoordinator = new InkInputCoordinator({
    sessionModel,
    epoch: sessionEpoch,
    config: {
      typingIdleDelay: config.typingIdleDelay,
      firstDropDelay: config.firstDropDelay,
      duration: textCfg.duration,
      emergeDuration: textCfg.emergeDuration,
    },
    isExternalBusy: () => chatDirector.isBusy || sessionTransition.isActive,
    displayPort: {
      setRenderText: (text) => {
        currentRenderText = text;
        textIsAi = false;
        textDissolve.value = 0.0;
        textAlpha = 1.0;
      },
      redrawFullCanvas: () => redrawFullCanvas(),
      animateTextErosion: (dur, done) => animateTextErosion(dur, done),
      animateTextEmergence: (dur, done) => animateTextEmergence(dur, done),
    },
    dropPort: {
      stop: () => stopDropCycle(),
      start: (delay) => {
        if (isEnabled) startDropCycle(delay);
      },
    },
    inputPort: {
      focus: () => {
        if (isEnabled && !sessionModel.isReplaying) focusInput();
      },
      onType: () => notifyType(),
    },
    onSubmitPrompt: (prompt) => commitAndErode(prompt),
  });

  // 仅重绘右页局部脏矩形（结构变更或静态就绪时调用，免去全量清屏与左页历史重复绘制）
  function redrawRightPage() {
    if (isPlayingOpeningSvg) {
      if (openingSvgCache) {
        ctx.clearRect(RIGHT_PAGE.x - 30, RIGHT_PAGE.y - 30, RIGHT_PAGE.w + 60, RIGHT_PAGE.h + 60);
        ctx.putImageData(openingSvgCache.bakedImageData, openingSvgCache.targetX, openingSvgCache.targetY);
        texture.needsUpdate = true;
      }
      return;
    }
    ctx.clearRect(RIGHT_PAGE.x - 30, RIGHT_PAGE.y - 30, RIGHT_PAGE.w + 60, RIGHT_PAGE.h + 60);
    renderRightPageText();
    dropPipeline.renderTo(ctx);
    texture.needsUpdate = true;
  }

  // 绘制整张双页画布（结构变更或静态就绪时调用）
  function redrawFullCanvas() {
    ctx.clearRect(0, 0, TEX_SIZE, TEX_SIZE);
    renderLeftPageHistory();
    if (isPlayingOpeningSvg) {
      if (openingSvgCache) {
        ctx.putImageData(openingSvgCache.bakedImageData, openingSvgCache.targetX, openingSvgCache.targetY);
      }
    } else {
      renderRightPageText();
      dropPipeline.renderTo(ctx);
    }
    texture.needsUpdate = true;
  }

  // 墨迹文本渲染过渡深模块 (InkTextTransitioner): 统一调度插入、更新、删除三大原语
  const textTransitioner = new InkTextTransitioner({
    dissolveDriver,
    historyView: leftHistoryView,
    redrawFullCanvas: () => redrawFullCanvas(),
    redrawRightPage: () => redrawRightPage(),
  });

  // 绘制左页历史对话列表（由 LeftPageHistoryView 深模块统一完成排版与 Green 通道骨架场编码）
  function renderLeftPageHistory() {
    const list = sessionModel.getFlattenedIndexItems();
    leftHistoryView.render(ctx, list);
  }

  // 记录最近一次由于首问标题更新或新增条目而计算的复合显影 Y 范围（或整页标记）
  let pendingEmergenceBound = null;
  let pendingIsFullPageEmergence = false;

  // 为左页新增历史项预备消融态并驱动反向毛细显影动画
  function prepareLeftItemEmergence(histItem) {
    const curSession = sessionModel.currentSession;
    // 判断是否发生了首问更名（由于 addHistory 已被调用，当前 session.hasCustomTitle 为 true，且 history 长度为 1）
    const isFirstQuestion = Boolean(curSession && curSession.history.length === 1);
    const items = sessionModel.getFlattenedIndexItems();
    // 判断是否有移位需求：已有多个条目且首项是当前新增项，或者条目位置产生下移
    const isFullPage = (isFirstQuestion && items.length > 1) || (items.length > 1 && items[0]?.id === curSession?.id);
    pendingIsFullPageEmergence = isFullPage;

    pendingEmergenceBound = textTransitioner.prepareHistoryAddition({
      sessionModel,
      histItem,
      isFirstQuestion,
      isFullPage,
    });
    // 显式保证驱动器状态与单条目边界基线同步
    if (!isFullPage) {
      dissolveDriver.prepareLeftItem(pendingEmergenceBound || leftHistoryView.getItemBounds(histItem.id));
    }
  }

  function animateLeftItemEmergence(histItem, duration = textCfg.emergeDuration, onComplete = null) {
    if (pendingIsFullPageEmergence) {
      pendingIsFullPageEmergence = false;
      pendingEmergenceBound = null;
      return dissolveDriver.emergeLeftHistory(duration, onComplete);
    }
    const boundInfo = pendingEmergenceBound || leftHistoryView.getItemBounds(histItem.id);
    pendingEmergenceBound = null;
    return textTransitioner.insertLeftText({
      boundInfo,
      duration,
      onComplete,
    });
  }

  // 绘制右页主文本（交由 InkRasterizer 深模块统一完成排版与骨架场烘焙）
  function renderRightPageText() {
    rasterizer.rasterizePage(ctx, currentRenderText, {
      isAi: textIsAi,
      alpha: textAlpha,
    });
  }

  // 计算右页当前文字末行末尾位置（作为下一个字符的插入符中心）
  function computeNextCharacterPosition() {
    const dropOffsetY = Math.round(FONT_RIGHT.size * 0.58);
    if (!currentRenderText) {
      return {
        x: RIGHT_PAGE.x + FONT_RIGHT.size * 0.5,
        y: RIGHT_PAGE.y + dropOffsetY,
      };
    }

    const lines = rasterizer.layout(currentRenderText, textIsAi, ctx);
    const lineCount = lines.length;
    const lastLine = lines[lineCount - 1] || '';

    ctx.save();
    ctx.font = `bold ${FONT_RIGHT.size}px ${textIsAi ? FONT_RIGHT.aiFamily : FONT_RIGHT.family}`;
    const lastLineWidth = ctx.measureText(lastLine).width;
    ctx.restore();

    // 墨点水平定位：文字右侧留出 8px 呼吸微间隙，随后对齐墨滴半径中心 (dotDiameter / 2)
    const CHAR_GAP = 8;
    const dropRadius = Math.round((config.dotDiameter || 24) * 0.5);
    const lineH = FONT_RIGHT.lineHeight;
    let targetX = RIGHT_PAGE.x + lastLineWidth + CHAR_GAP + dropRadius;
    let targetY = RIGHT_PAGE.y + (lineCount - 1) * lineH + dropOffsetY;

    // 若当前行末尾已容纳不下墨滴（或下个字符必然折行），折行至下一行开头
    if (targetX > RIGHT_PAGE.x + RIGHT_PAGE.w) {
      targetX = RIGHT_PAGE.x + dropRadius;
      targetY += lineH;
    }

    return { x: targetX, y: targetY };
  }

  const _tempProjVec = new THREE.Vector3();
  const INPUT_LINE_HEIGHT = 28;

  function updateHiddenInputPosition() {
    if (!stage || !stage.camera || !surfaceEvaluator) return;
    const canvasPos = computeNextCharacterPosition();
    const surface = surfaceEvaluator.evaluate(canvasPos);
    if (!surface || !surface.position) return;
    _tempProjVec.copy(surface.position).project(stage.camera);
    if (!Number.isFinite(_tempProjVec.x) || !Number.isFinite(_tempProjVec.y)) return;
    if (_tempProjVec.z > 1.0) return;

    const width = typeof window !== 'undefined' ? window.innerWidth : 1920;
    const height = typeof window !== 'undefined' ? window.innerHeight : 1080;
    const screenX = (_tempProjVec.x * 0.5 + 0.5) * width;
    const screenY = (-(_tempProjVec.y * 0.5) + 0.5) * height;

    hiddenInput.style.left = `${Math.round(screenX)}px`;
    hiddenInput.style.top = `${Math.round(screenY - INPUT_LINE_HEIGHT * 0.5)}px`;
    hiddenInput.style.height = `${INPUT_LINE_HEIGHT}px`;
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', updateHiddenInputPosition);
  }
  hiddenInput.addEventListener('focus', () => updateHiddenInputPosition());

  function focusInput() {
    if (isEnabled && !sessionModel.isReplaying) {
      updateHiddenInputPosition();
      hiddenInput.focus({ preventScroll: true });
    }
  }

  function stopDropCycle() {
    dropPipeline.stop();
  }

  function startDropCycle(delay = 0) {
    if (!isEnabled) return;
    dropPipeline.start(delay);
  }

  // 文字内容变更后的待输入墨滴重置：先隐去当前墨滴，再于打字静止间隙后在最新字尾重新滴落
  function scheduleDropCycleRestart() {
    stopDropCycle();
    if (isInputLocked()) return;
    startDropCycle(config.typingIdleDelay);
  }

  function stopEmergence() {
    inputCoordinator.stopEmergence();
  }

  function renderCurrentPage(forceEmergence = false, textOverride = null) {
    inputCoordinator.renderCurrentPage(forceEmergence, textOverride, hiddenInput.selectionStart);
  }

  function triggerPageEmergence(curText, onFinished = null) {
    inputCoordinator.triggerPageEmergence(curText, onFinished);
  }

  function commitAndErode(fullPrompt) {
    chatDirector.submit(fullPrompt);
  }

  function animateTextEmergence(duration, onComplete) {
    return dissolveDriver.emergeRight(duration, onComplete);
  }

  function animateTextErosion(duration, onComplete) {
    return dissolveDriver.dissolveRight(duration, () => {
      currentRenderText = '';
      redrawRightPage();
      if (onComplete) onComplete();
    });
  }

  // ---------- 换页复显 (Session Reset Dissolution) ----------

  // 左右页文字以同一支余弦缓动同时被纸面吸干；左页文字留在画布上只是隐入消融态，等换纸落定后整页复显
  function animatePagesErosion(duration, onComplete) {
    return dissolveDriver.dissolveBothPages(duration, onComplete);
  }

  // 左页历史索引整页反向毛细显影归位（Y 带留空即全局生效）
  function animateLeftHistoryEmergence(duration, onComplete) {
    return dissolveDriver.emergeLeftHistory(duration, onComplete);
  }

  function blankPagesForNewSession() {
    sessionModel.createSession();
    hiddenInput.value = '';
    currentRenderText = '';
    textIsAi = false;
    textAlpha = 1.0;
    redrawFullCanvas();
  }

  function unlockAfterSessionReset() {
    if (!isEnabled) return;
    focusInput();
    startDropCycle(config.firstDropDelay);
  }

  // 历史会话流式回响调度深模块实例 (SessionEchoPlayback)
  const echoPlayback = new SessionEchoPlayback({
    config: {
      emergeDuration: 800,
      stayDuration: 1800,
      dissolveDuration: 800,
      staggerMs: 800,
      lineHeight: 44,
      paragraphSpacing: 14,
      paddingTop: 12,
      paddingBottom: 12,
    },
    clock: {
      now: () => performance.now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h),
    },
    layoutPort: {
      leftPage: LEFT_PAGE,
      rightPage: RIGHT_PAGE,
      wrapText: (text, maxW) => {
        ctx.save();
        ctx.font = `bold ${FONT_RIGHT.size}px ${FONT_RIGHT.family}`;
        const lines = wrapTextLines(text, maxW, (str) => ctx.measureText(str).width);
        ctx.restore();
        return lines;
      },
    },
    renderPort: {
      onRenderFrame: (activeFragments) => {
        ctx.clearRect(LEFT_PAGE.x - 20, LEFT_PAGE.y - 20, LEFT_PAGE.w + 40, LEFT_PAGE.h + 40);
        ctx.clearRect(RIGHT_PAGE.x - 20, RIGHT_PAGE.y - 20, RIGHT_PAGE.w + 40, RIGHT_PAGE.h + 40);

        ctx.save();
        ctx.textBaseline = 'top';

        for (const frag of activeFragments) {
          const isAi = frag.role === 'ai';
          ctx.font = `bold ${FONT_RIGHT.size}px ${isAi ? FONT_RIGHT.aiFamily : FONT_RIGHT.family}`;
          ctx.fillStyle = isAi ? 'rgba(32, 22, 14, 0.95)' : 'rgba(20, 13, 7, 0.95)';

          const fragH = frag.lines.length * 44;
          const rx = Math.max(0, Math.floor(frag.x - 8));
          const ry = Math.max(0, Math.floor(frag.y - 8));
          const rw = Math.min(TEX_SIZE - rx, Math.ceil(frag.w + 16));
          const rh = Math.min(TEX_SIZE - ry, Math.ceil(fragH + 16));

          const activeDissolve = frag.dissolveAmount ?? (1.0 - (frag.opacity ?? 1.0));

          if (activeDissolve >= 0.999) {
            // 完全消融态，无需光栅化
            continue;
          }

          ctx.globalAlpha = 1.0;
          for (let l = 0; l < frag.lines.length; l++) {
            ctx.fillText(frag.lines[l], frag.x, frag.y + l * 44);
          }
          if (rw > 0 && rh > 0 && ctx.getImageData) {
            const imgData = ctx.getImageData(rx, ry, rw, rh);
            const skeleton = computeSkeletonField(imgData.data, rw, rh, { isRgba: true });
            if (activeDissolve > 0.005) {
              applyMorphologicalDissolution(imgData.data, skeleton, rw * rh, activeDissolve, isAi);
            } else {
              const d = imgData.data;
              for (let i = 0; i < rw * rh; i++) {
                d[i * 4 + 1] = skeleton[i];
              }
            }
            ctx.putImageData(imgData, rx, ry);
          }
        }
        ctx.restore();
        texture.needsUpdate = true;
      },
      onClear: () => {
        ctx.clearRect(LEFT_PAGE.x - 20, LEFT_PAGE.y - 20, LEFT_PAGE.w + 40, LEFT_PAGE.h + 40);
        ctx.clearRect(RIGHT_PAGE.x - 20, RIGHT_PAGE.y - 20, RIGHT_PAGE.w + 40, RIGHT_PAGE.h + 40);
        texture.needsUpdate = true;
      },
    },
  });

  // 把上一代还在跑的动画与墨滴全部收干净：两支消融 uniform 只允许一个归属者
  function cancelInflightSessionAnimations() {
    chatDirector.cancelAll({ preserveText: true });
    if (echoPlayback.isActive) {
      echoPlayback.interrupt();
    }
    dissolveDriver.cancelAll();
    inputCoordinator.cancelAll();
    sessionEpoch.advance();
    stopDropCycle();
  }

  // 合书出口：不演了，纸面直接落到换页终态（根据当前 session 状态直接落定）
  function settleSessionTransitionAtOnce() {
    cancelInflightSessionAnimations();
    if (activeTransitionType === 'reset') {
      blankPagesForNewSession();
    } else if (activeTransitionType === 'switch' && pendingSwitchSessionId) {
      sessionModel.switchSession(pendingSwitchSessionId);
      applySwitchedSessionDraft();
    }
    redrawFullCanvas();
    unlockAfterTransition();
  }

  let activePlayLeaf = null;
  let activeTransitionType = 'reset'; // 'reset' | 'switch'
  let pendingSwitchSessionId = null;

  function applySwitchedSessionDraft() {
    hiddenInput.value = sessionModel.inputBuffer;
    currentRenderText = sessionModel.inputBuffer;
    textIsAi = false;
    textAlpha = 1.0;
  }

  function unlockAfterTransition() {
    if (!isEnabled) return;
    if (activeTransitionType === 'switch') return;
    focusInput();
    if (sessionModel.hasDraft) {
      renderCurrentPage(true);
    } else {
      startDropCycle(config.firstDropDelay);
    }
  }

  let onTransitionStartCallback = null;
  let onLeafSettledCallback = null;
  let onTransitionEndCallback = null;

  const sessionTransition = new SessionTransitionSequence({
    clock: {
      now: () => performance.now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (handle) => clearTimeout(handle),
    },
    timings: {
      dissolveMs: textCfg.duration,
      settlePauseMs: 200,
      emergeMs: textCfg.emergeDuration,
    },
    exec: {
      cancelInflight: cancelInflightSessionAnimations,
      onTransitionStart: () => {
        if (onTransitionStartCallback) onTransitionStartCallback();
      },
      dissolvePages: (ms, done) => animatePagesErosion(ms, done),
      prepareSwap: () => {
        if (activeTransitionType === 'reset') {
          blankPagesForNewSession();
          redrawFullCanvas();
        } else if (activeTransitionType === 'switch' && pendingSwitchSessionId) {
          sessionModel.switchSession(pendingSwitchSessionId);
          applySwitchedSessionDraft();
          // 切页回放前，先清空双页画布并将 Uniform 归零，为流式回响做好纯净舞台
          ctx.clearRect(0, 0, TEX_SIZE, TEX_SIZE);
          dissolveDriver.cancelAll();
          texture.needsUpdate = true;
        }
      },
      playLeaf: ({ direction }, done) => {
        if (activePlayLeaf) {
          activePlayLeaf({ direction }, done);
        } else {
          done();
        }
      },
      unlockInput: () => {
        unlockAfterTransition();
        if (onLeafSettledCallback) onLeafSettledCallback({ transitionType: activeTransitionType });
      },
      emergePages: (ms, done) => {
        if (activeTransitionType === 'switch') {
          const targetSession = sessionModel.currentSession;
          const historyItems = targetSession?.history || [];

          const finalizeSwitch = () => {
            dissolveDriver.leftEmergingYRange.value.set(-1.0, -1.0);
            dissolveDriver.leftTextDissolve.value = 1.0;
            const hasDraft = sessionModel.hasDraft;
            if (hasDraft) {
              dissolveDriver.textDissolve.value = 1.0;
            }
            redrawFullCanvas();
            dissolveDriver.emergeBothPages(ms, hasDraft, done);
          };

          if (historyItems.length === 0) {
            finalizeSwitch();
            return;
          }

          echoPlayback.renderPort.onComplete = () => {
            finalizeSwitch();
          };

          echoPlayback.start(historyItems);
        } else {
          const hasDraft = sessionModel.hasDraft;
          dissolveDriver.emergeBothPages(ms, hasDraft, done);
        }
      },
      onTransitionEnd: () => {
        if (activeTransitionType === 'switch') {
          focusInput();
          if (sessionModel.hasDraft) {
            renderCurrentPage(true);
          } else {
            startDropCycle(config.firstDropDelay);
          }
        }
        if (onTransitionEndCallback) onTransitionEndCallback();
      },
      settleAtOnce: settleSessionTransitionAtOnce,
    },
  });

  // 切换历史 Session：消融双页文字 -> 切换机位至中缝 -> 播放单页翻页动画(右向左翻) -> 重新反向显影
  function switchSession(sessionId) {
    if (!isEnabled || sessionTransition.isActive || echoPlayback.isActive) return;
    if (sessionModel.currentSessionId === sessionId) return;

    resetHoverState();

    if (sessionModel.isReplaying) {
      exitHistoryReplay(true);
    }

    stopEmergence();
    stopDropCycle();

    activeTransitionType = 'switch';
    pendingSwitchSessionId = sessionId;

    try {
      for (const listener of switchSessionListeners) {
        listener(sessionId);
      }
    } catch (err) {
      console.error('Error invoking switch session listener:', err);
    }

    const leftItems = sessionModel.getFlattenedIndexItems();
    const hasInk = Boolean(currentRenderText) || sessionModel.hasDraft || leftItems.length > 0;

    sessionTransition.begin({
      direction: 'backward',
      hasInk,
      requiresGate: false,
    });
  }

  // 点击左页回顾演播或切换历史 Session
  function handleLeftPageClick(uv) {
    if (!isEnabled || sessionTransition.isActive || echoPlayback.isActive) return;
    const hit = leftHistoryView.hitTest(uv);
    if (!hit) return;

    if (hit.type === 'session') {
      if (!hit.isCurrent) {
        switchSession(hit.sessionId);
      }
    } else if (hit.type === 'history' && hit.histItem) {
      startHistoryReplay(hit.histItem);
    }
  }

  function startHistoryReplay(histItem) {
    if (!isEnabled) return;
    resetHoverState();
    dissolveDriver.cancelLeft();
    const currentCursor = hiddenInput.selectionStart ?? sessionModel.inputBuffer.length;
    chatDirector.startReplay(histItem, currentCursor);
  }

  function exitHistoryReplay(immediate = false) {
    chatDirector.interruptReplay(immediate);
  }

  // 输入法与键盘交互
  const isInputLocked = () => inputCoordinator.isLocked || sessionTransition.isActive || echoPlayback.isActive;

  hiddenInput.addEventListener('compositionstart', (e) => {
    if (isInputLocked()) {
      e.preventDefault();
      return;
    }
    inputCoordinator.handleCompositionStart();
  });

  hiddenInput.addEventListener('compositionupdate', () => {
    if (isInputLocked()) return;
    inputCoordinator.handleCompositionUpdate();
  });

  hiddenInput.addEventListener('compositionend', () => {
    if (isInputLocked()) return;
    // 必须先隐去旧墨滴再重绘，否则重绘会把旧位图画到新的字尾坐标上，产生单帧平移跳跃
    scheduleDropCycleRestart();
    renderCurrentPage(false, hiddenInput.value);
    inputCoordinator.handleCompositionEnd(hiddenInput.value, hiddenInput.selectionStart);
    updateHiddenInputPosition();
  });

  hiddenInput.addEventListener('input', () => {
    if (isPlayingOpeningSvg) {
      cancelOpeningSvgDissolve();
    }
    if (isInputLocked()) {
      hiddenInput.value = sessionModel.inputBuffer;
      return;
    }
    if (!inputCoordinator.isComposing) {
      scheduleDropCycleRestart();
      renderCurrentPage(false, hiddenInput.value);
      inputCoordinator.handleInput(hiddenInput.value, hiddenInput.selectionStart);
      updateHiddenInputPosition();
    }
  });

  hiddenInput.addEventListener('keydown', (e) => {
    if (isPlayingOpeningSvg) {
      cancelOpeningSvgDissolve();
    }

    if (echoPlayback.isActive) {
      echoPlayback.interrupt();
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (sessionModel.isReplaying) {
      exitHistoryReplay();
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (isInputLocked()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (e.key === 'Enter' && !inputCoordinator.isComposing) {
      const handled = inputCoordinator.handleEnter();
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    } else if (e.key === ' ' || e.key === 'Spacebar') {
      e.stopPropagation();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (isEnabled && echoPlayback.isActive) {
      echoPlayback.interrupt();
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    if (isEnabled && sessionModel.isReplaying) {
      exitHistoryReplay();
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
      }
    }
  });

  function setEnabled(enabled) {
    if (enabled) {
      if (!isEnabled) {
        isEnabled = true;
        focusInput();
        if (!isPlayingOpeningSvg) {
          startDropCycle(config.firstDropDelay);
        }
        redrawFullCanvas();
      }
    } else {
      if (isEnabled) {
        isEnabled = false;
        hiddenInput.blur();
        resetHoverState();
        stopDropCycle();
        stopEmergence();
        chatDirector.cancelAll();
        sessionTransition.abort();
        if (echoPlayback.isActive) {
          echoPlayback.interrupt();
        }
        inputCoordinator.cancelAll();
        if (sessionModel.isReplaying) {
          exitHistoryReplay(true);
        }
        currentRenderText = '';
        redrawFullCanvas();
      }
    }
  }

  // 响应 3D 点击书面
  function handleBookClick(hit) {
    if (!isEnabled) return;
    if (echoPlayback.isActive) {
      echoPlayback.interrupt();
      return;
    }
    if (sessionTransition.isActive) return;
    if (sessionModel.isReplaying) {
      exitHistoryReplay();
      return;
    }

    if (hit && hit.uv) {
      // 检查是否点击在左页
      if (hit.point.x < 0) {
        handleLeftPageClick(hit.uv);
        return;
      }
    }
    focusInput();
  }

  // 左页 Hover 下划线动效与状态调度
  let currentHoveredItem = null;
  let hoverDebounceTimer = null;
  let hoverAnimFrameId = null;

  function cancelHoverAnimation() {
    if (hoverAnimFrameId) {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(hoverAnimFrameId);
      }
      hoverAnimFrameId = null;
    }
  }

  function redrawLeftPage() {
    ctx.clearRect(0, 0, TEX_SIZE * 0.5, TEX_SIZE);
    renderLeftPageHistory();
    texture.needsUpdate = true;
  }

  function animateHoverStroke(fromProgress, toProgress, duration, onComplete = null) {
    cancelHoverAnimation();
    const startTime = performance.now();
    leftHoverProgress.value = fromProgress;

    const step = () => {
      const elapsed = performance.now() - startTime;
      const progress = Math.min(elapsed / duration, 1.0);
      const ease = 1.0 - Math.pow(1.0 - progress, 2);
      leftHoverProgress.value = fromProgress + (toProgress - fromProgress) * ease;

      if (progress < 1.0) {
        hoverAnimFrameId = requestAnimationFrame(step);
      } else {
        hoverAnimFrameId = null;
        leftHoverProgress.value = toProgress;
        if (onComplete) onComplete();
      }
    };
    hoverAnimFrameId = requestAnimationFrame(step);
  }

  function applyHoverTarget(targetItem) {
    cancelHoverAnimation();

    if (!targetItem) {
      if (currentHoveredItem) {
        currentHoveredItem = null;
        // 移出：从左向右运笔原路擦除 (240ms)，mode=2.0，progress 从 0.0 推进至 1.0
        leftHoverMode.value = 2.0;
        animateHoverStroke(0.0, 1.0, 240, () => {
          leftHistoryView.setHoveredId(null);
          redrawLeftPage();
          leftHoverMode.value = 0.0;
          leftHoverBox.value.set(-1.0, -1.0, -1.0, -1.0);
        });
      }
      return;
    }

    currentHoveredItem = targetItem;
    const box = targetItem.underlineBox;
    if (box) {
      leftHoverBox.value.set(box.uMin, box.uMax, box.vMin, box.vMax);
    }
    // 移入：从左向右运笔绘制延伸 (240ms)，mode=1.0，progress 从 0.0 推进至 1.0
    // 先将 mode 设为 1.0 且 progress 为 0.0，使 Shader 完全遮蔽，再重绘 Canvas 下划线，杜绝单帧闪烁
    leftHoverMode.value = 1.0;
    leftHoverProgress.value = 0.0;
    leftHistoryView.setHoveredId(targetItem.id);
    redrawLeftPage();

    animateHoverStroke(0.0, 1.0, 240, () => {
      // 划线绘制完毕，重置 mode 为 0.0（下划线在 Canvas 上已完整呈现）
      leftHoverMode.value = 0.0;
      leftHoverProgress.value = 1.0;
    });
  }

  function handleHover(hit) {
    if (!isEnabled || sessionTransition.isActive) {
      if (currentHoveredItem) {
        applyHoverTarget(null);
      }
      return;
    }

    let targetItem = null;
    if (hit && hit.uv && hit.point && hit.point.x < 0) {
      const h = leftHistoryView.hitTest(hit.uv);
      if (h) {
        // 当前活跃 Session 标题已常驻下划线，无需重复 hover 下划线显隐
        const isCurrentSession = h.type === 'session' && h.isCurrent;
        if (!isCurrentSession) {
          targetItem = h;
        }
      }
    }

    const targetId = targetItem ? targetItem.id : null;
    const currentId = currentHoveredItem ? currentHoveredItem.id : null;
    if (targetId === currentId) return;

    if (hoverDebounceTimer) {
      clearTimeout(hoverDebounceTimer);
    }

    // 50ms 悬停防抖
    hoverDebounceTimer = setTimeout(() => {
      hoverDebounceTimer = null;
      applyHoverTarget(targetItem);
    }, 50);
  }

  function resetHoverState() {
    if (hoverDebounceTimer) {
      clearTimeout(hoverDebounceTimer);
      hoverDebounceTimer = null;
    }
    cancelHoverAnimation();
    currentHoveredItem = null;
    leftHistoryView.setHoveredId(null);
    leftHoverMode.value = 0.0;
    leftHoverProgress.value = 0.0;
    leftHoverBox.value.set(-1.0, -1.0, -1.0, -1.0);
  }

  // 初始全量绘制
  redrawFullCanvas();

  // 确保自定义书法字体在 Canvas 绘制前加载生效，若异步下载完成则自动重绘
  if (typeof document !== 'undefined' && document.fonts) {
    document.fonts.load(`bold ${FONT_RIGHT.size}px "Tangerine"`).then(() => {
      redrawFullCanvas();
    });
    document.fonts.load(`bold ${FONT_RIGHT.size}px "Long Cang"`).then(() => {
      redrawFullCanvas();
    });
    document.fonts.load(`bold ${FONT_RIGHT.size}px "WangHanZong-ZhongXingShu"`).then(() => {
      redrawFullCanvas();
    });
    document.fonts.ready.then(() => {
      redrawFullCanvas();
    });
  }

  function finishOpeningSvgDissolve() {
    isPlayingOpeningSvg = false;
    clearTimeout(openingSvgTimer);
    openingSvgTimer = null;
    ctx.clearRect(RIGHT_PAGE.x - 30, RIGHT_PAGE.y - 30, RIGHT_PAGE.w + 60, RIGHT_PAGE.h + 60);
    dissolveDriver.textDissolve.value = 0.0;
    renderRightPageText();
    if (isEnabled) {
      startDropCycle(config.firstDropDelay);
    }
    dropPipeline.renderTo(ctx);
    texture.needsUpdate = true;
  }

  function cancelOpeningSvgDissolve() {
    if (!isPlayingOpeningSvg) return;
    isPlayingOpeningSvg = false;
    clearTimeout(openingSvgTimer);
    openingSvgTimer = null;
    dissolveDriver.cancelRight();
    ctx.clearRect(RIGHT_PAGE.x - 30, RIGHT_PAGE.y - 30, RIGHT_PAGE.w + 60, RIGHT_PAGE.h + 60);
    dissolveDriver.textDissolve.value = 0.0;
    renderRightPageText();
    if (isEnabled) {
      startDropCycle(config.firstDropDelay);
    }
    dropPipeline.renderTo(ctx);
    texture.needsUpdate = true;
  }

  return {
    texture,
    textDissolve,
    leftTextDissolve,
    leftEmergingYRange,
    leftHoverBox,
    leftHoverProgress,
    leftHoverMode,
    handleHover,
    setEnabled,
    isFocused: () => document.activeElement === hiddenInput,
    focus: focusInput,
    blur: () => hiddenInput.blur(),
    update: () => {
      if (typeof document !== 'undefined' && document.activeElement === hiddenInput) {
        updateHiddenInputPosition();
      }
    },
    updateInputPosition: updateHiddenInputPosition,
    exitReplay: exitHistoryReplay,
    /**
     * 开启一次换页复显（点击墨水瓶触发）
     * @param {{ playLeaf: (params: Object, done: Function) => void }} options 由舞台层注入"放一次单页换纸"
     * @returns {boolean} 是否受理
     */
    beginSessionReset: ({ playLeaf }) => {
      if (!isEnabled || sessionTransition.isActive || sessionModel.isReplaying) return false;
      if (sessionModel.hasDraft && !currentRenderText) {
        currentRenderText = sessionModel.getCurrentPageInfo().text || sessionModel.inputBuffer;
        redrawRightPage();
      }
      activePlayLeaf = playLeaf;
      activeTransitionType = 'reset';
      pendingSwitchSessionId = null;
      const leftItems = sessionModel.getFlattenedIndexItems();
      const hasInk = Boolean(currentRenderText) || sessionModel.hasDraft || leftItems.length > 0;
      for (const listener of newSessionListeners) {
        try { listener(); } catch (err) { console.error('Error invoking new session listener:', err); }
      }
      return sessionTransition.begin({
        direction: 'forward',
        hasInk,
        requiresGate: true,
      });
    },
    setPlayLeaf: (playLeaf) => {
      activePlayLeaf = playLeaf;
    },
    onTransitionStart: (cb) => {
      onTransitionStartCallback = cb;
    },
    onLeafSettled: (cb) => {
      onLeafSettledCallback = cb;
    },
    onTransitionEnd: (cb) => {
      onTransitionEndCallback = cb;
    },
    isSessionResetting: () => sessionTransition.isActive,
    isTransitioning: () => sessionTransition.isActive,
    signalQuillSettled: () => sessionTransition.openLeafGate(),
    finishSessionReset: () => sessionTransition.abort(),
    switchSession,
    onSwitchSession: (cb) => {
      if (typeof cb === 'function') switchSessionListeners.push(cb);
    },
    onNewSession: (cb) => {
      if (typeof cb === 'function') newSessionListeners.push(cb);
    },
    syncSessions: (sessions) => {
      const oldItems = sessionModel.getFlattenedIndexItems();
      sessionModel.setExternalSessions(sessions);
      const newItems = sessionModel.getFlattenedIndexItems();

      // 检测外部会话列表是否发生顺序变化（例如非空列表首项变化，或已有项重排序位移）
      const hasShift = oldItems.length > 0 && newItems.length > 0 && (
        oldItems.length !== newItems.length ||
        oldItems[0]?.id !== newItems[0]?.id ||
        newItems.some((item, idx) => oldItems[idx]?.id !== item.id)
      );

      // 若处于非转场、非回放空闲态且发生位移，驱动左页平滑吸干后反向显影
      if (hasShift && !sessionTransition.isActive && !echoPlayback.isActive && !chatDirector.isBusy) {
        dissolveDriver.dissolveLeftHistory(textCfg.duration / 2, () => {
          renderLeftPageHistory();
          dissolveDriver.emergeLeftHistory(textCfg.emergeDuration);
        });
      }
    },
    setSessionChatHistory: (sessionId, history) => {
      sessionModel.setSessionChatHistory(sessionId, history);
    },
    setPromptPort: (fn) => {
      chatDirector.promptPort = fn;
    },
    setValidatePort: (fn) => {
      chatDirector.validatePort = fn;
    },
    setOnCancel: (fn) => {
      chatDirector.onCancel = fn;
    },
    chatDirector,
    sessionModel,
    echoPlayback,
    isEchoReplaying: () => echoPlayback.isActive,
    handleClick: handleBookClick,
    setBookMeshes: (meshes) => {
      surfaceEvaluator.setBookMeshes(meshes);
    },
    dropPipeline,
    onType: (callback) => {
      onTypeListeners.push(callback);
    },
    onDropPhase: (callback) => {
      dropPhaseListeners.push(callback);
    },
    getDropPhase: () => dropPipeline.currentPhase,
    preloadOpeningSvg: (url) => preloadOpeningSvg(url, RIGHT_PAGE),
    playOpeningSvgDissolve: ({
      svgUrl = '/assets/image.svg',
      emergeDuration = 3000,
      stayDuration = 3000,
      dissolveDuration = 2000,
      onComplete = null,
    } = {}) => {
      if (echoPlayback.isActive || chatDirector.isBusy || sessionTransition.isActive) {
        if (onComplete) onComplete();
        return;
      }

      cancelOpeningSvgDissolve();
      isPlayingOpeningSvg = true;
      stopDropCycle();

      (async () => {
        const cached = openingSvgCache || (await preloadOpeningSvg(svgUrl, RIGHT_PAGE));
        if (!cached || !isPlayingOpeningSvg) {
          isPlayingOpeningSvg = false;
          if (isEnabled) {
            startDropCycle(config.firstDropDelay);
          }
          if (onComplete) onComplete();
          return;
        }

        ctx.clearRect(RIGHT_PAGE.x - 30, RIGHT_PAGE.y - 30, RIGHT_PAGE.w + 60, RIGHT_PAGE.h + 60);
        ctx.putImageData(cached.bakedImageData, cached.targetX, cached.targetY);
        texture.needsUpdate = true;

        // 1. 反向毛细显影 (1.0 -> 0.0)，传入 redraw = false 避免初始 0ms 冲刷已写入的题跋
        dissolveDriver.textDissolve.value = 1.0;
        dissolveDriver.emergeRight(emergeDuration, () => {
          if (!isPlayingOpeningSvg) return;
          // 2. 定格停留
          openingSvgTimer = setTimeout(() => {
            if (!isPlayingOpeningSvg) return;
            // 3. 吸干消融 (0.0 -> 1.0)，传入 redrawOnFinish = false，完成由 finishOpeningSvgDissolve 统一收尾
            dissolveDriver.dissolveRight(dissolveDuration, () => {
              if (!isPlayingOpeningSvg) return;
              finishOpeningSvgDissolve();
              if (onComplete) onComplete();
            }, false);
          }, stayDuration);
        }, false);
      })();
    },
    cancelOpeningSvgDissolve,
    isPlayingOpeningSvg: () => isPlayingOpeningSvg,
    testRenderSvgDissolve: (svgUrl = '/assets/image.svg', duration = 1200) => {
      return new Promise((resolve) => {
        playOpeningSvgDissolve({
          svgUrl,
          emergeDuration: duration,
          stayDuration: 1200,
          dissolveDuration: duration,
          onComplete: resolve,
        });
      });
    },
  };
}

// 开场题跋 SVG 状态与预加载缓存闭包
let openingSvgCache = null;
let isPlayingOpeningSvg = false;
let openingSvgTimer = null;

async function preloadOpeningSvg(svgUrl = '/assets/image.svg', rightPage = null) {
  if (openingSvgCache) return openingSvgCache;
  if (typeof Image === 'undefined' || typeof document === 'undefined') return null;

  try {
    const img = new Image();
    img.src = svgUrl;
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
    });

    const pageW = rightPage ? rightPage.w : 2048 * 0.36;
    const pageH = rightPage ? rightPage.h : 2048 * 0.45;
    const pageX = rightPage ? rightPage.x : 2048 * 0.56;
    const pageY = rightPage ? rightPage.y : 2048 * 0.29;

    const svgAspect = (img.naturalWidth || 1865) / (img.naturalHeight || 576);
    // 顶部与首行待输入区域对齐：横向占满右页可写宽度的 88%，纵向顶格对齐首行 pageY
    let targetW = Math.round(pageW * 0.88);
    let targetH = Math.round(targetW / svgAspect);
    if (targetH > pageH) {
      targetH = pageH;
      targetW = Math.round(targetH * svgAspect);
    }
    const targetX = Math.round(pageX + (pageW - targetW) / 2);
    const targetY = Math.round(pageY);

    const offW = Math.round(targetW);
    const offH = Math.round(targetH);
    const offCanvas = document.createElement('canvas');
    offCanvas.width = offW;
    offCanvas.height = offH;
    const offCtx = offCanvas.getContext('2d');
    offCtx.drawImage(img, 0, 0, offW, offH);

    const rawData = offCtx.getImageData(0, 0, offW, offH);
    const extracted = extractInkFromImageData(rawData, { inkThreshold: 12 });
    const { bakedImageData } = bakeSkeletonToGreenChannel(extracted);

    openingSvgCache = {
      bakedImageData,
      targetX,
      targetY,
      w: offW,
      h: offH,
    };
    return openingSvgCache;
  } catch (err) {
    console.warn('预加载开场题跋 SVG 异常:', err);
    return null;
  }
}
