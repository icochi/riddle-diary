import test from 'node:test';
import assert from 'node:assert/strict';
import { LeftPageHistoryView } from '../src/left-page-history-view.js';

function createMockCtx() {
  const calls = {
    fillText: [],
    strokes: 0,
    paths: [],
  };
  return {
    calls,
    save: () => {},
    restore: () => {},
    fillText: (text, x, y) => {
      calls.fillText.push({ text, x, y });
    },
    measureText: (text) => ({ width: text.length * 20 }),
    getImageData: (x, y, w, h) => ({
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: () => {},
    beginPath: () => {},
    moveTo: (x, y) => {
      calls.paths.push({ type: 'moveTo', x, y });
    },
    quadraticCurveTo: (cpx, cpy, x, y) => {
      calls.paths.push({ type: 'quadraticCurveTo', cpx, cpy, x, y });
    },
    stroke: () => {
      calls.strokes++;
    },
  };
}

test('LeftPageHistoryView calculates capacity from font line height', () => {
  const view = new LeftPageHistoryView({
    pageRect: { x: 100, y: 500, w: 700, h: 900 },
    fontConfig: { size: 34, lineHeight: 52, family: 'sans-serif' },
    canvasSize: 2048,
  });

  // itemHeight = 52 + 6 = 58; capacity = floor(900 / 58) = 15
  assert.equal(view.capacity, 15);
});

test('LeftPageHistoryView renders items and computes bounding ranges', () => {
  const view = new LeftPageHistoryView({
    pageRect: { x: 160, y: 590, w: 730, h: 920 },
    fontConfig: { size: 34, lineHeight: 52, family: 'sans-serif' },
    canvasSize: 2048,
  });
  const ctx = createMockCtx();

  const items = [
    { id: 'sess_1', type: 'session', title: '新篇章', sessionId: 'sess_1', isCurrent: true },
    { id: 'q_1', type: 'history', title: '你好是谁？', histItem: { id: 'q_1' }, isActive: true },
  ];

  view.render(ctx, items);

  const boundSess = view.getItemBounds('sess_1');
  assert.ok(boundSess);
  assert.equal(boundSess.type, 'session');
  assert.ok(boundSess.yMinNorm > 0 && boundSess.yMaxNorm > boundSess.yMinNorm);

  const boundQ = view.getItemBounds('q_1');
  assert.ok(boundQ);
  assert.equal(boundQ.type, 'history');
  assert.ok(boundQ.yMinNorm > boundSess.yMinNorm);

  // 验证 Session 标题去除了方块图标 ◆ / ◇
  assert.equal(ctx.calls.fillText[0].text, '新篇章');
  assert.equal(ctx.calls.fillText[1].text, '你好是谁？');

  // 新规则：sess_1(isCurrent=true) 拥有常驻下划线 (2 次 stroke)，而 q_1(isActive=true) 在未 hover 时不绘制下划线
  assert.equal(ctx.calls.strokes, 2);

  // 验证各条目包含合法的 underlineYRange 归一化区间
  assert.ok(boundSess.underlineYRange && boundSess.underlineYRange.yMinNorm > 0);
  assert.ok(boundQ.underlineYRange && boundQ.underlineYRange.yMinNorm > boundSess.underlineYRange.yMinNorm);
});

test('LeftPageHistoryView draws underline on hovered item and clears when unhovered', () => {
  const view = new LeftPageHistoryView({
    pageRect: { x: 160, y: 590, w: 730, h: 920 },
    fontConfig: { size: 34, lineHeight: 52, family: 'sans-serif' },
    canvasSize: 2048,
  });

  const items = [
    { id: 'sess_1', type: 'session', title: '新篇章', sessionId: 'sess_1', isCurrent: true },
    { id: 'q_1', type: 'history', title: '你好是谁？', histItem: { id: 'q_1' }, isActive: true },
  ];

  // 1. 设置 hover q_1
  view.setHoveredId('q_1');
  const ctxHover = createMockCtx();
  view.render(ctxHover, items);
  // sess_1(常驻) + q_1(hover) 均绘制下划线
  assert.ok(ctxHover.calls.strokes >= 4);

  // 2. 取消 hover
  view.setHoveredId(null);
  const ctxUnhover = createMockCtx();
  view.render(ctxUnhover, items);
  // 恢复为仅 sess_1 绘制下划线
  assert.equal(ctxUnhover.calls.strokes, 2);
});

test('LeftPageHistoryView hitTest maps silver-ratio UV coordinates to correct item', () => {
  const view = new LeftPageHistoryView({
    pageRect: { x: 160, y: 590, w: 730, h: 920 },
    fontConfig: { size: 34, lineHeight: 52, family: 'sans-serif' },
    canvasSize: 2048,
  });
  const ctx = createMockCtx();

  const items = [
    { id: 'sess_1', type: 'session', title: '新篇章', sessionId: 'sess_1', isCurrent: true },
    { id: 'hist_1', type: 'history', title: '你是谁', sessionId: 'sess_1', histItem: { id: 'h1' }, isCurrent: false },
  ];
  view.render(ctx, items);

  // 第一行 canvasY = 590，计算对应的 UV:
  // texV = (uv.y - 0.5) * 0.7071 + 0.5 = 590 / 2048 => uv.y ≈ 0.2057
  // texU = (1.0 - uv.x) * 0.5 => 取左页中缝与外缘正中 uv.x = 0.5 => texU = 0.25 (落在 [160-50, 160+730+50] 范围内)
  const targetCanvasY = 590 + 20; // 第一行内部
  const targetTexV = targetCanvasY / 2048;
  const targetUvY = (targetTexV - 0.5) / 0.7071 + 0.5;

  const hit1 = view.hitTest({ x: 0.5, y: targetUvY });
  assert.ok(hit1);
  assert.equal(hit1.type, 'session');
  assert.equal(hit1.sessionId, 'sess_1');
  assert.ok(hit1.underlineYRange && hit1.underlineYRange.yMinNorm > 0);

  // 第二行
  const targetCanvasY2 = 590 + 58 + 20;
  const targetTexV2 = targetCanvasY2 / 2048;
  const targetUvY2 = (targetTexV2 - 0.5) / 0.7071 + 0.5;

  const hit2 = view.hitTest({ x: 0.5, y: targetUvY2 });
  assert.ok(hit2);
  assert.equal(hit2.type, 'history');
  assert.equal(hit2.histItem.id, 'h1');
  assert.ok(hit2.underlineYRange && hit2.underlineYRange.yMinNorm > hit1.underlineYRange.yMinNorm);

  // 水平脱靶（点击在右页或装订中缝外侧）
  const hitMiss = view.hitTest({ x: 0.05, y: targetUvY });
  assert.equal(hitMiss, null);
});
