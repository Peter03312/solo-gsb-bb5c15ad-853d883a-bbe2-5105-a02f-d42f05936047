'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createApp } = require('../src/routes');
const { toWebVtt, parseWebVtt } = require('../src/vtt');

let server;
let base;
let db;

before(async () => {
  db = initDb(':memory:');
  const app = createApp(db);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function api(path, method = 'GET', body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

const GOOD_WORDS = [
  { text: '你好', start_ms: 0, end_ms: 500 },
  { text: '世界', start_ms: 550, end_ms: 1000 },
  { text: '欢迎', start_ms: 1500, end_ms: 2000 },
  { text: '光临', start_ms: 2050, end_ms: 2500 },
];

async function setupProject(name = '正文无损测试') {
  const created = await api('/api/projects', 'POST', { name, words: GOOD_WORDS, cuts: [1200] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const pid = created.body.id;
  const layout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 0 });
  assert.equal(layout.status, 200, JSON.stringify(layout.body));
  return { pid, cues: layout.body.subtitles, sub_version: layout.body.sub_version };
}

/** 直接改库，模拟旧库遗留的不合格正文（绕过 API 闸门） */
function corruptCueText(pid, sid, text) {
  db.prepare('UPDATE subtitles SET text = ? WHERE id = ? AND project_id = ?').run(text, sid, pid);
}
function corruptTranslation(pid, lang, sid, text) {
  db.prepare(
    `UPDATE translations SET text = ? WHERE project_id = ? AND lang = ? AND subtitle_id = ?`
  ).run(text, pid, lang, sid);
}

// ---------- 导入 ----------

test('导入：词文本含段内空白行/回车被拒绝并指出是哪个词（422）', async () => {
  const r1 = await api('/api/projects', 'POST', {
    name: '导入坏词1',
    words: [
      { text: '正常词', start_ms: 0, end_ms: 500 },
      { text: '两行\n\n空行', start_ms: 550, end_ms: 1000 },
    ],
  });
  assert.equal(r1.status, 422);
  assert.ok(r1.body.errors.some((e) => e.includes('第 1 个词') && e.includes('空白行')),
    JSON.stringify(r1.body.errors));

  const r2 = await api('/api/projects', 'POST', {
    name: '导入坏词2',
    words: [{ text: '尾换行\n', start_ms: 0, end_ms: 500 }],
  });
  assert.equal(r2.status, 422);
  assert.ok(r2.body.errors.some((e) => e.includes('末行为空')));
});

test('导入：段内单换行的词文本合法（trim 后仍为单换行）', async () => {
  const r = await api('/api/projects', 'POST', {
    name: '导入合法多行',
    words: [{ text: '第一行\n第二行', start_ms: 0, end_ms: 500 }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
});

// ---------- 字幕编辑 ----------

test('字幕编辑：首尾换行/空白行/回车被拒绝（422，指出行），段内单换行允许', async () => {
  const { pid, cues } = await setupProject();
  const c = cues[0];
  for (const bad of ['尾部\n', '\n首部', '中间\n\n空行', '回车\r\n行']) {
    const r = await api(`/api/projects/${pid}/subtitles/${c.id}`, 'PATCH', {
      version: c.version, text: bad,
    });
    assert.equal(r.status, 422, `${JSON.stringify(bad)} 应被拒绝`);
    assert.ok(r.body.errors.some((e) => e.includes(`第 ${c.idx + 1} 行`)), JSON.stringify(r.body.errors));
  }
  // 段内单换行合法，可保存
  const ok = await api(`/api/projects/${pid}/subtitles/${c.id}`, 'PATCH', {
    version: c.version, text: '上行\n下行',
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.subtitle.text, '上行\n下行');
});

// ---------- 修订提议 ----------

test('修订提议：建议正文不合格 → 422 不保存提议；采纳闸也拒绝遗留不合格提议', async () => {
  const { pid, cues } = await setupProject();
  const c = cues[0];
  const r = await api(`/api/projects/${pid}/revisions`, 'POST', {
    items: [{ subtitle_id: c.id, cue_version: c.version, text: '建议\n\n空行' }],
  });
  assert.equal(r.status, 422);
  assert.ok(r.body.errors.some((e) => e.includes('空白行')));
  const list = await api(`/api/projects/${pid}/revisions`);
  assert.equal(list.body.length, 0, '被拒绝的提议不得保存');

  // 直接往库里插一条遗留的不合格提议，采纳时必须 422 整组不生效
  const rid = db.prepare(
    `INSERT INTO revisions (project_id, note, rules_version_snapshot, sub_version_snapshot)
     VALUES (?, '', 1, ?)`
  ).run(pid, 0).lastInsertRowid;
  db.prepare(
    `INSERT INTO revision_items
       (revision_id, ord, subtitle_id, cue_version, orig_text, orig_start_ms, orig_end_ms,
        proposed_text, start_ms, end_ms)
     VALUES (?, 0, ?, ?, ?, ?, ?, ?, NULL, NULL)`
  ).run(rid, c.id, c.version, c.text, c.start_ms, c.end_ms, '坏正文\n尾部\n');
  const accept = await api(`/api/projects/${pid}/revisions/${rid}/accept`, 'POST');
  assert.equal(accept.status, 422);
  assert.ok(accept.body.items.some((it) =>
    it.reasons.some((rs) => rs.type === 'cue_text_unwritable')), JSON.stringify(accept.body));
  const after = await api(`/api/projects/${pid}`);
  assert.equal(after.body.subtitles.find((s) => s.id === c.id).text, c.text, '整组不得生效');
});

// ---------- 单条译文 ----------

test('单条译文：不合格正文 → 400 不写入；段内单换行合法并可导出', async () => {
  const { pid, cues } = await setupProject();
  const c = cues[0];
  const bad = await api(`/api/projects/${pid}/translations/en/subtitles/${c.id}`,
    'PUT', { text: 'Hello\n', cue_version: c.version });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.some((e) => e.includes('末行为空')));

  const ok = await api(`/api/projects/${pid}/translations/en/subtitles/${c.id}`,
    'PUT', { text: 'Line one\nLine two', cue_version: c.version });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

// ---------- 整批回填 ----------

test('整批回填：任一行正文不合格 → 400 整批不写入、不占批次编号', async () => {
  const { pid, cues, sub_version } = await setupProject();
  const r = await api(`/api/projects/${pid}/translations/en/batches`, 'POST', {
    batch_no: 'B001', sub_version, rules_version: 1,
    items: [
      { subtitle_id: cues[0].id, cue_version: cues[0].version, version: 0, text: 'Hello' },
      { subtitle_id: cues[1].id, cue_version: cues[1].version, version: 0, text: '尾换行\n' },
    ],
  });
  assert.equal(r.status, 400);
  assert.ok(r.body.errors.some((e) => e.includes('items[1]')));
  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.counts.missing, 2, '整批不得写入');
  const batches = await api(`/api/projects/${pid}/translation-batches`);
  assert.equal(batches.body.batches.length, 0, '失败不占批次编号');

  // 改成合法正文后整批成功
  const ok = await api(`/api/projects/${pid}/translations/en/batches`, 'POST', {
    batch_no: 'B001', sub_version, rules_version: 1,
    items: [
      { subtitle_id: cues[0].id, cue_version: cues[0].version, version: 0, text: 'Hello' },
      { subtitle_id: cues[1].id, cue_version: cues[1].version, version: 0, text: 'Welcome' },
    ],
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

// ---------- 历史恢复 ----------

test('历史恢复：候选译文正文不合格 → 422 整组不恢复', async () => {
  const { pid, cues, sub_version } = await setupProject();
  const c = cues[0];
  // 造一条同导入代次的 history 译文（词区间/源文一致，但正文带尾部换行）
  const histId = db.prepare(
    `INSERT INTO translations
       (project_id, lang, subtitle_id, text, status, version, cue_version_snapshot,
        src_text, src_start_ms, src_end_ms, src_word_start, src_word_end, src_import_id)
     VALUES (?, 'en', NULL, '历史译文\n', 'history', 1, ?,
        ?, ?, ?, ?, ?, 1)`
  ).run(pid, c.version, c.text, c.start_ms, c.end_ms, c.word_start, c.word_end).lastInsertRowid;
  const r = await api(`/api/projects/${pid}/translations/en/recover`, 'POST', {
    sub_version, rules_version: 1,
    items: [{ subtitle_id: c.id, cue_version: c.version, translation_id: histId, version: 1 }],
  });
  assert.equal(r.status, 422);
  assert.ok(r.body.items[0].reasons.some((x) => x.includes('无法无损写成单个')), JSON.stringify(r.body));
  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.counts.missing, 2, '不得恢复');
});

// ---------- 旧库脏数据：四类导出写快照前列问题行 ----------

test('原文导出：旧库不合格正文 → 422 列问题行，不占导出版本；修正后照常导出', async () => {
  const { pid, cues } = await setupProject();
  corruptCueText(pid, cues[1].id, '坏正文\n尾部\n');
  const r = await api(`/api/projects/${pid}/exports`, 'POST', {});
  assert.equal(r.status, 422);
  const bodyBad = r.body.conflicts.filter((x) => x.type === 'cue_text_unwritable');
  assert.equal(bodyBad.length, 1);
  assert.equal(bodyBad[0].subtitle_id, cues[1].id);
  assert.match(bodyBad[0].message, /第 2 行/);
  const list = await api(`/api/projects/${pid}/exports`);
  assert.equal(list.body.length, 0, '不得占导出版本');

  // 修正该行 → 导出成功，且内容可被原样解析
  const fix = await api(`/api/projects/${pid}/subtitles/${cues[1].id}`, 'PATCH', {
    version: cues[1].version, text: '修好的正文',
  });
  assert.equal(fix.status, 200);
  const ok = await api(`/api/projects/${pid}/exports`, 'POST', { sub_version: fix.body.sub_version });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const parsed = parseWebVtt(ok.body.content);
  assert.equal(parsed.ok, true, parsed.reason);
});

test('单语导出：旧库不合格源正文或译文 → 422 列问题行，不生成快照', async () => {
  const { pid, cues } = await setupProject();
  // 两条都先存合法译文
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello', cue_version: cues[0].version });
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[1].id}`,
    'PUT', { text: 'Welcome', cue_version: cues[1].version });

  // 源正文脏 → conflicts
  corruptCueText(pid, cues[0].id, '源\n\n空行');
  const r1 = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', {});
  assert.equal(r1.status, 422);
  assert.ok(r1.body.conflicts.some((x) => x.type === 'cue_text_unwritable'));
  corruptCueText(pid, cues[0].id, '你好世界');

  // 译文脏 → invalid 行列原因
  corruptTranslation(pid, 'en', cues[1].id, 'Welcome\n');
  const r2 = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', {});
  assert.equal(r2.status, 422);
  assert.ok(r2.body.invalid.some((x) => x.subtitle_id === cues[1].id
    && x.reasons.some((m) => m.includes('无法无损写成单个'))), JSON.stringify(r2.body.invalid));
  const list = await api(`/api/projects/${pid}/translations/en/exports`);
  assert.equal(list.body.length, 0, '不得生成译文快照');
});

test('署名版导出：旧库不合格源正文 → 422 conflicts 列行；不合格译文 → rows 列行', async () => {
  const { pid, cues, sub_version } = await setupProject();
  // 建说话人并逐行归属（每次标注都推进 attribution_version）
  const sp = await api(`/api/projects/${pid}/speakers`, 'POST', { display_name: '甲' });
  assert.equal(sp.status, 201);
  let attr = 0;
  for (const c of cues) {
    const a = await api(`/api/projects/${pid}/attributions/subtitles/${c.id}`, 'PUT', {
      attribution_version: attr, cue_version: c.version, speaker_number: 1,
    });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    attr = a.body.attribution_version;
  }

  // 源正文脏（直接改库不改版本；sub_version 取当前值）
  const curSub = (await api(`/api/projects/${pid}`)).body.sub_version;
  corruptCueText(pid, cues[0].id, '源尾部\n');
  const r1 = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version: curSub, attribution_version: attr,
  });
  assert.equal(r1.status, 422);
  assert.ok(r1.body.conflicts.some((x) => x.type === 'cue_text_unwritable'));
  corruptCueText(pid, cues[0].id, '你好世界');

  // 译文脏（译文署名导出）
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello', cue_version: cues[0].version });
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[1].id}`,
    'PUT', { text: 'Welcome', cue_version: cues[1].version });
  corruptTranslation(pid, 'en', cues[0].id, 'Hello\r\nx');
  const r2 = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version: curSub, attribution_version: attr, lang: 'en',
    translations: cues.map((c) => ({ subtitle_id: c.id, version: 1 })),
  });
  assert.equal(r2.status, 422);
  assert.ok(r2.body.rows.some((row) => row.subtitle_id === cues[0].id
    && row.reasons.some((m) => m.includes('无法无损写成单个'))), JSON.stringify(r2.body.rows));
  const list = await api(`/api/projects/${pid}/attributed-exports`);
  assert.equal(list.body.exports.length, 0, '不得生成署名快照');
});

test('多语交付：任一文件正文不合格 → 422 整批失败，不占任何导出版本', async () => {
  const { pid, cues, sub_version } = await setupProject();
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello', cue_version: cues[0].version });
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[1].id}`,
    'PUT', { text: 'Welcome', cue_version: cues[1].version });
  // 把一条译文改脏（current，尾部换行）
  corruptTranslation(pid, 'en', cues[1].id, 'Welcome\n');

  const r = await api(`/api/projects/${pid}/deliveries`, 'POST', {
    sub_version, rules_version: 1, languages: ['en'],
    translations: { en: cues.map((c) => ({ subtitle_id: c.id, version: 1 })) },
  });
  assert.equal(r.status, 422);
  assert.ok(r.body.languages[0].invalid.some((x) => x.subtitle_id === cues[1].id),
    JSON.stringify(r.body.languages));

  // 四个序列都不得占版本
  assert.equal((await api(`/api/projects/${pid}/deliveries`)).body.batches.length, 0);
  assert.equal((await api(`/api/projects/${pid}/exports`)).body.length, 0);
  assert.equal((await api(`/api/projects/${pid}/translations/en/exports`)).body.length, 0);

  // 修正译文后整批成功
  corruptTranslation(pid, 'en', cues[1].id, 'Welcome');
  const ok = await api(`/api/projects/${pid}/deliveries`, 'POST', {
    sub_version, rules_version: 1, languages: ['en'],
    translations: { en: cues.map((c) => ({ subtitle_id: c.id, version: 1 })) },
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

// ---------- 冻结文件兼容 ----------

test('已冻结文件：下载/差异/返修接口约定保持兼容（旧坏快照仅按既有损坏口径报错）', async () => {
  const { pid } = await setupProject();
  // 手工写一个“旧时代”产生的坏快照：正文后带空行，空行之后还有内容 →
  // 解析器把后面那行当成不含时间行的块，按既有口径判快照损坏。
  const badContent = 'WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\n正文\n\n脱离 cue 的残行';
  db.prepare('INSERT INTO exports (project_id, version, content, cue_count) VALUES (?, 1, ?, 1)')
    .run(pid, badContent);
  // 下载接口原样返回（不改动冻结内容、不新增错误码）
  const dl = await api(`/api/projects/${pid}/exports/1`);
  assert.equal(dl.status, 200);
  assert.equal(dl.body, badContent);
  // 解析按既有约定判损坏（非新错误码）
  assert.equal(parseWebVtt(badContent).ok, false);
});

test('toWebVtt 输出的多行正文：往返与差异比较保持一致', () => {
  const content = toWebVtt([{ start_ms: 0, end_ms: 1000, text: '上行\n下行' }]);
  const parsed = parseWebVtt(content);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.cues[0].text, '上行\n下行');
});
