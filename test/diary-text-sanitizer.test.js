import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeDiaryText } from '../src/diary-text-sanitizer.js';

test('sanitizeDiaryText strips bold, italic, and strikethrough markdown', () => {
  const input = '这是**粗体**与*斜体*以及~~删除线~~测试。';
  const expected = '这是粗体与斜体以及删除线测试。';
  assert.equal(sanitizeDiaryText(input), expected);
});

test('sanitizeDiaryText strips headers and preserves text', () => {
  const input = '# 一级标题\n\n正文内容\n\n### 三级标题\n结尾。';
  const expected = '一级标题\n\n正文内容\n\n三级标题\n结尾。';
  assert.equal(sanitizeDiaryText(input), expected);
});

test('sanitizeDiaryText formats code blocks with full-width incantation indentation', () => {
  const input = '一段代码：\n```python\ndef spell():\n    return "Lumos"\n```\n结束。';
  const sanitized = sanitizeDiaryText(input);
  assert.match(sanitized, /一段代码：/);
  assert.match(sanitized, /　　def spell\(\):/);
  assert.match(sanitized, /　　    return "Lumos"/);
  assert.ok(!sanitized.includes('```'));
  assert.ok(!sanitized.includes('python'));
});

test('sanitizeDiaryText converts inline code to plain text', () => {
  const input = '使用 `const x = 1;` 变量声明。';
  assert.equal(sanitizeDiaryText(input), '使用 const x = 1; 变量声明。');
});

test('sanitizeDiaryText strips links keeping anchor text', () => {
  const input = '详情请参阅 [豆包官网](https://doubao.com) 页面。';
  assert.equal(sanitizeDiaryText(input), '详情请参阅 豆包官网 页面。');
});

test('sanitizeDiaryText strips LaTeX formula delimiters', () => {
  const input = '根据质能方程 $E = mc^2$ 可知：\n$$\nE = mc^2\n$$';
  const sanitized = sanitizeDiaryText(input);
  assert.ok(!sanitized.includes('$'));
  assert.match(sanitized, /E = mc\^2/);
});

test('sanitizeDiaryText formats simple markdown tables into natural lines', () => {
  const input = '| 属性 | 说明 |\n| --- | --- |\n| 力量 | 100 |\n| 智力 | 90 |';
  const sanitized = sanitizeDiaryText(input);
  assert.ok(!sanitized.includes('|'));
  assert.match(sanitized, /力量: 100/);
  assert.match(sanitized, /智力: 90/);
});

test('sanitizeDiaryText normalizes multiple empty lines', () => {
  const input = '段落一\n\n\n\n\n段落二';
  assert.equal(sanitizeDiaryText(input), '段落一\n\n段落二');
});
