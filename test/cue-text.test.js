'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cueBodyProblems, isWritableCueText } = require('../src/cue-text');
const { toWebVtt, parseWebVtt } = require('../src/vtt');

test('合法正文：单行、段内单换行、空载荷均通过', () => {
  for (const t of ['普通一行', '第一行\n第二行', 'a\nb\nc', '', '行内 空白 保留']) {
    assert.deepEqual(cueBodyProblems(t), [], `应为合法：${JSON.stringify(t)}`);
    assert.equal(isWritableCueText(t), true);
  }
});

test('首部换行/空白行被拒绝并指出第 1 行', () => {
  const ps = cueBodyProblems('\n正文');
  assert.equal(ps.length, 1);
  assert.equal(ps[0].code, 'leading_blank_line');
  assert.equal(ps[0].line, 1);
  assert.equal(isWritableCueText('\n正文'), false);

  const ps2 = cueBodyProblems('  \n正文');
  assert.equal(ps2[0].code, 'leading_blank_line');
});

test('尾部换行被拒绝并指出末行（静默丢失场景）', () => {
  const ps = cueBodyProblems('正文\n');
  assert.equal(ps.length, 1);
  assert.equal(ps[0].code, 'trailing_blank_line');
  assert.equal(ps[0].line, 2);
  assert.equal(isWritableCueText('正文\n\n'), false);
});

test('段内空白行（连续换行）被拒绝并指出对应行', () => {
  const ps = cueBodyProblems('第一段\n\n第二段');
  assert.equal(ps.length, 1);
  assert.equal(ps[0].code, 'blank_line');
  assert.equal(ps[0].line, 2);

  const psTab = cueBodyProblems('第一段\n \t \n第二段');
  assert.equal(psTab[0].code, 'blank_line');
  assert.equal(psTab[0].line, 2);
});

test('纯空白单行被拒绝（会被切块规则吞成空载荷）', () => {
  assert.equal(isWritableCueText('   '), false);
  assert.ok(['leading_blank_line', 'trailing_blank_line'].includes(cueBodyProblems('   ')[0].code));
});

test('回车符（CR/CRLF）被拒绝（解析端归一 LF，无法无损）', () => {
  assert.equal(cueBodyProblems('第一行\r\n第二行')[0].code, 'carriage_return');
  assert.equal(cueBodyProblems('a\rb')[0].code, 'carriage_return');
});

test('非字符串返回整体问题', () => {
  assert.equal(cueBodyProblems(null)[0].code, 'not_text');
  assert.equal(isWritableCueText(undefined), false);
});

test('toWebVtt 对不合法正文直接抛错（写入侧最后一道闸）', () => {
  assert.throws(() => toWebVtt([{ start_ms: 0, end_ms: 1000, text: '坏\n' }]), /无法无损/);
});

test('往返性质：合法正文写入后可被 parseWebVtt 原样取回', () => {
  for (const t of ['第一行\n第二行', '单行', '']) {
    const parsed = parseWebVtt(toWebVtt([{ start_ms: 0, end_ms: 1000, text: t }]));
    assert.equal(parsed.ok, true, parsed.reason);
    assert.equal(parsed.cues[0].text, t);
  }
});
