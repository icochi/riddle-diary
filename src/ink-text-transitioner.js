/**
 * 墨迹文本渲染过渡器深模块 (InkTextTransitioner)
 *
 * 职责：
 * 1. 统一管理墨迹文字演化的三大核心原语 (Three Text Transition Primitives):
 *    - 插入 (insert): 预设目标区域消融隐匿态 -> 写入 Canvas -> 反向毛细显影 (快出缓入余弦曲线)
 *    - 更新 (update): 局部区域消融吸干 (缓入快出) -> 刷新 Canvas -> 局部反向毛细显影
 *    - 删除 (delete): 局部或整页消融吸干直至墨色褪尽 -> 清除 Canvas 像素
 * 2. 封装左页历史索引项变动（新增问答历史条目、首问更新 Session 标题）的过渡编排，
 *    彻底消除直接调用 redrawCanvas 引起的无动画硬刷与跳变闪烁；
 * 3. 管理过渡生命周期与取消句柄，保证与世代隔离及合书/打断机制的安全联动。
 */

export class InkTextTransitioner {
  /**
   * @param {Object} options
   * @param {Object} options.dissolveDriver 双页消融显影着色器驱动器 (InkDissolveDriver)
   * @param {Object} options.historyView 左页历史索引视图 (LeftPageHistoryView)
   * @param {() => void} options.redrawFullCanvas 全局贴图重绘
   * @param {() => void} [options.redrawRightPage] 右页贴图重绘
   */
  constructor({ dissolveDriver, historyView, redrawFullCanvas, redrawRightPage = null }) {
    this.dissolveDriver = dissolveDriver;
    this.historyView = historyView;
    this.redrawFullCanvas = redrawFullCanvas;
    this.redrawRightPage = redrawRightPage;
    this.activeCancel = null;
  }

  /**
   * 中止当前正在执行的过渡动画
   */
  cancel() {
    if (this.activeCancel) {
      this.activeCancel();
      this.activeCancel = null;
    }
  }

  /**
   * 原语 1: 插入文本 (Insert)
   * 先预设目标区域消融隐匿态，更新 Canvas 后驱动反向毛细显影
   * @param {Object} options
   * @param {{ yMinNorm: number, yMaxNorm: number } | null} options.boundInfo 归一化 YRange 作用域
   * @param {() => void} [options.render] Canvas 写入回调
   * @param {number} options.duration 显影时长 (ms)
   * @param {() => void} [options.onComplete] 完成回调
   * @returns {() => void} 取消句柄
   */
  insertLeftText({ boundInfo, render, duration, onComplete = null }) {
    this.cancel();
    if (boundInfo) {
      this.dissolveDriver.prepareLeftItem(boundInfo);
    }
    if (render) {
      render();
    }
    let active = true;
    const cancel = this.dissolveDriver.emergeLeftItem(boundInfo, duration, () => {
      active = false;
      this.activeCancel = null;
      if (onComplete) onComplete();
    });
    if (active) {
      this.activeCancel = cancel;
    }
    return cancel;
  }

  /**
   * 原语 2: 更新文本 (Update)
   * 目标区域先消融吸干，再刷新 Canvas 写入新内容，随后反向毛细显影
   * @param {Object} options
   * @param {{ yMinNorm: number, yMaxNorm: number } | null} options.dissolveBoundInfo 消融区域
   * @param {{ yMinNorm: number, yMaxNorm: number } | null} [options.emergeBoundInfo] 显影区域（默认为 dissolveBoundInfo）
   * @param {number} options.dissolveDuration 消融时长 (ms)
   * @param {number} options.emergeDuration 显影时长 (ms)
   * @param {() => void} options.render Canvas 刷新回调
   * @param {() => void} [options.onComplete]
   * @returns {() => void}
   */
  updateLeftText({
    dissolveBoundInfo,
    emergeBoundInfo = null,
    dissolveDuration = 300,
    emergeDuration = 1050,
    render,
    onComplete = null,
  }) {
    this.cancel();

    let finished = false;
    let stageCancel = null;

    stageCancel = this.dissolveDriver.dissolveLeftItem(dissolveBoundInfo, dissolveDuration, () => {
      if (finished) return;

      const targetEmergeBound = emergeBoundInfo || dissolveBoundInfo;
      // 预设显影态并重绘
      if (targetEmergeBound) {
        this.dissolveDriver.prepareLeftItem(targetEmergeBound);
      }
      if (render) {
        render();
      }

      stageCancel = this.dissolveDriver.emergeLeftItem(targetEmergeBound, emergeDuration, () => {
        finished = true;
        this.activeCancel = null;
        if (onComplete) onComplete();
      });
    });

    const cancel = () => {
      if (finished) return;
      finished = true;
      if (stageCancel) stageCancel();
      this.activeCancel = null;
    };

    if (!finished) {
      this.activeCancel = cancel;
    }
    return cancel;
  }

  /**
   * 原语 3: 删除文本 (Delete)
   * 目标区域消融吸干后，执行清空重绘
   * @param {Object} options
   * @param {{ yMinNorm: number, yMaxNorm: number } | null} options.boundInfo
   * @param {number} options.duration
   * @param {() => void} [options.afterClear]
   * @param {() => void} [options.onComplete]
   * @returns {() => void}
   */
  deleteLeftText({ boundInfo, duration, afterClear = null, onComplete = null }) {
    this.cancel();
    let finished = false;
    const cancel = this.dissolveDriver.dissolveLeftItem(boundInfo, duration, () => {
      finished = true;
      if (afterClear) afterClear();
      this.activeCancel = null;
      if (onComplete) onComplete();
    });
    if (!finished) {
      this.activeCancel = cancel;
    }
    return cancel;
  }

  /**
   * 提交问答前对左页进行吸干消融：
   * 若为首问立项（将导致新标题插入首行），或当前会话非首位（将发生置顶位移），
   * 触发左页整页吸干消融，与右页提问文字同步隐入纸背；
   * 若无其他条目或无位移，则保持静默或仅消融局部。
   * @param {Object} sessionModel
   * @param {number} [dissolveDuration=2400]
   * @param {() => void} [onComplete]
   */
  dissolveInitialTitleIfNeeded(sessionModel, dissolveDuration = 2400, onComplete = null) {
    const curSession = sessionModel.currentSession;
    if (!curSession) {
      if (onComplete) onComplete();
      return null;
    }

    const items = sessionModel.getFlattenedIndexItems();
    const isFirstQuestion = Boolean(!curSession.hasCustomTitle || curSession.history.length === 0);
    // 判断是否会引起左页已有条目位移：
    // 1. 首问立项且当前左页已有其他历史条目；
    // 2. 当前活跃会话不在左页第一项（将发生置顶位移）。
    const willShift = (isFirstQuestion && items.length > 0) || (items.length > 1 && items[0]?.id !== curSession.id);

    if (willShift) {
      return this.dissolveDriver.dissolveLeftHistory(dissolveDuration, onComplete);
    }

    if (onComplete) onComplete();
    return null;
  }

  /**
   * 提交问答后，计算受影响的范围并预置消融隐匿态
   * @param {Object} options
   * @param {Object} options.sessionModel
   * @param {Object} options.histItem 新增的历史项
   * @param {boolean} options.isFirstQuestion 是否是首问更新标题
   * @param {boolean} [options.isFullPage=false] 是否为整页过渡
   * @returns {{ yMinNorm: number, yMaxNorm: number } | null}
   */
  prepareHistoryAddition({ sessionModel, histItem, isFirstQuestion, isFullPage = false }) {
    // 刷新贴图前预设消融，防止闪烁
    const tempBound = { yMinNorm: 0.0, yMaxNorm: 1.0 };
    this.dissolveDriver.prepareLeftItem(tempBound);
    this.redrawFullCanvas();

    if (isFullPage) {
      // 整页消融态
      this.dissolveDriver.leftTextDissolve.value = 1.0;
      this.dissolveDriver.leftEmergingYRange.value.set(-1.0, -1.0);
      return null;
    }

    const histBounds = histItem ? this.historyView.getItemBounds(histItem.id) : null;
    let combinedBounds = null;

    if (isFirstQuestion && sessionModel.currentSession) {
      const sessionBounds = this.historyView.getItemBounds(sessionModel.currentSession.id) || this.historyView.getItemBoundsByIndex(0);
      if (sessionBounds && histBounds) {
        combinedBounds = {
          yMinNorm: Math.min(sessionBounds.yMinNorm, histBounds.yMinNorm),
          yMaxNorm: Math.max(sessionBounds.yMaxNorm, histBounds.yMaxNorm),
        };
      } else {
        combinedBounds = sessionBounds || histBounds;
      }
    } else {
      combinedBounds = histBounds;
    }

    // 将确切的作用域预置为 1.0 消融态
    this.dissolveDriver.prepareLeftItem(combinedBounds);
    return combinedBounds;
  }
}
