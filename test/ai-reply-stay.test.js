import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { aiPageStayMs } from '../src/ink.js';

test('短回复沿用原有停留时长，不因折算而变长', () => {
  assert.equal(aiPageStayMs(18, true), 4200, '18 字末页仍是 4200ms');
  assert.equal(aiPageStayMs(18, false), 3200, '18 字非末页仍是 3200ms');
});

test('停留时长按该页字数折算阅读时间', () => {
  assert.equal(aiPageStayMs(40, false), 4800);
  assert.equal(aiPageStayMs(80, false), 9600);
});

test('满页折算触顶即止，不至于把整段演出拖没边', () => {
  assert.equal(aiPageStayMs(190, false), 16000);
  assert.equal(aiPageStayMs(5000, true), 16000);
});

test('自定义配置覆盖生效于折算的每一个旋钮', () => {
  const cfg = { aiStayTime: 1000, aiLastPageStay: 1500, aiStayPerChar: 200, aiStayMax: 3000 };
  assert.equal(aiPageStayMs(2, false, cfg), 1000, '低于下限时抬到下限');
  assert.equal(aiPageStayMs(2, true, cfg), 1500, '末页下限独立');
  assert.equal(aiPageStayMs(20, false, cfg), 3000, '高于上限时压到上限');
});

test('复演的提示页不算末页，单页提示也只用基础下限', () => {
  const src = readFileSync(resolve('src/chat-ink-director.js'), 'utf-8');
  const start = src.indexOf('_playReplaySequence(pages, isAi, onSequenceComplete)');
  assert.ok(start > -1, '找不到 _playReplaySequence');
  const body = src.slice(start, src.indexOf('\n  }', start));
  const calls = [...body.matchAll(/calculateAiPageStayMs\(([^)]*)\)/g)].map((m) => m[1]);
  assert.equal(calls.length, 1, '复演的停留时长应只有一处折算调用');
  assert.ok(
    body.includes('isLastPage = isAi && idx === pages.length - 1'),
    '末页判定必须只在 AI 回复段生效，提示页读完还有回复页要读'
  );
});

/**
 * 判定 `guard(` 的实参列表里是否出现了第二个实参（顶层逗号）。
 * 从 guard 左括号后一位开始扫描，括号深度回到 0 之前仍在深度 1、花括号 0 处遇到逗号即为多余实参。
 */
function guardTakesExtraArg(src, openAt) {
  let pd = 1;
  let bd = 0;
  for (let i = openAt; i < src.length; i++) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < src.length && (src[j] !== ch || src[j - 1] === '\\')) j++;
      i = j;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i) - 1; continue; }
    if (ch === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (ch === '(') pd++;
    else if (ch === ')') { pd--; if (pd === 0) return false; }
    else if (ch === '{') bd++;
    else if (ch === '}') bd--;
    else if (ch === ',' && pd === 1 && bd === 0) return true;
  }
  return false;
}

test('ink.js 中被 guard 包裹的回调必须正确保持世代隔离', () => {
  const src = readFileSync(resolve('src/ink.js'), 'utf-8');
  const sites = [...src.matchAll(/guard\(/g)];
  assert.ok(sites.length >= 2, '本用例检查 guard 包裹的回调');
  const offenders = sites
    .filter((m) => guardTakesExtraArg(src, m.index + m[0].length))
    .map((m) => src.slice(0, m.index).split('\n').length);
  assert.deepEqual(offenders, [],
    'guard(fn, ms) 会让 ms 变成 guard 的多余实参，setTimeout 退化成 0ms，纸面来不及读完就吸干');
});
