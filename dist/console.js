/**
 * 语音转文本的控制台面板（浏览器侧 bundle）。
 *
 * 宿主按 `/assets/extensions/<包>/<版本>/dist/console.js` 取这个文件，
 * 直接 `import()` 它的 default 导出；所以它是纯浏览器 ES 模块：
 * 不 import 任何东西（`cortico/*` 在这里只允许 `import type`），只用 ctx.ui。
 */

const STYLE = `
.st-list { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.st-item { border: 1px solid rgba(128,128,128,.35); border-radius: 10px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }
.st-item.st-hit { outline: 2px solid #4aa8ff; outline-offset: 2px; }
.st-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.st-name { font-weight: 600; word-break: break-word; }
.st-sub { opacity: .65; font-size: 11px; word-break: break-all; }
.st-text { font-size: 12px; white-space: pre-wrap; word-break: break-word; }
.st-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 2px; }
.st-empty { padding: 22px 8px; text-align: center; opacity: .8; }
.st-conn { display: flex; gap: 6px; align-items: center; }
.st-testrow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.st-file { opacity: .8; font-size: 12px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

const ZH = {
  listTitle: '转写',
  listEn: 'Transcripts',
  listDesc: '转写过的记录；可复制文本、看来源。源音频不会被复制。',
  statusTitle: '状态',
  statusEn: 'Status',
  statusDesc: '接口、密钥与记录目录。',
  refresh: '刷新',
  selfTest: '插入自检记录',
  selfTestDone: '自检记录已写入：入库 → 索引 → 页面，这条路是通的。',
  selfTestBad: '自检失败',
  clearAll: '清空记录',
  clearAsk: '清空所有记录？',
  clearBody: '所有转写记录都会删掉；源音频不动，不能撤销。',
  cleared: '清空完成',
  remove: '删除',
  removeAsk: '删掉这条记录？',
  removeBody: '记录会被删掉；源音频不动。',
  removed: '已删除',
  copyText: '复制文字',
  copySource: '复制来源',
  count: '记录',
  audioBytes: '听过音频',
  shown: '本页显示',
  connecting: '实时推送未连接',
  connected: '实时推送中',
  busier: '处理中…',
  empty: '还没有转写记录。让桌宠转写一段音频，或者点「插入自检记录」看看链路通不通。',
  loadBad: '读不到转写记录',
  unknown: '未知',
  keyField: '转写接口密钥',
  keyHint: '密钥只写进 .env。',
  keyPlaceholder: '粘贴 API key 后保存',
  keyPlaceholderSet: '已配置；粘贴新的可以覆盖',
  keyEmpty: '先粘贴密钥',
  keySaved: '密钥已保存',
  keyCleared: '密钥已清除',
  clearKey: '清除密钥',
  clearKeyBody: '会把 .env 里那一行置空。之后转写会直接失败，直到重新填入。',
  saveKey: '保存密钥',
  testTitle: '试转写',
  testDesc: '选一个音频文件，用当前配置真转写一次，并记入列表。',
  pickFile: '选音频文件',
  pickTitle: '选一段要转写的音频',
  pickNone: '未选择文件',
  pickEmpty: '先选一个音频文件',
  pickRun: '转写并入库',
  testDone: '转写完成',
  testBad: '转写失败',
  noText: '（没识别出文字）',
  endpoint: '接口地址',
  protocol: '接口协议',
  model: '模型',
  langHint: '语言提示',
  context: '语境提示',
  keepDialect: '保留方言',
  itn: '数字规范化',
  sampleRate: '采样率',
  maxMb: '文件上限',
  autoLabel: '自动',
  onLabel: '开',
  offLabel: '关',
  timeout: '单次超时',
  keyName: '密钥变量名',
  keyState: '密钥',
  keyFrom: '密钥来源',
  fromBot: '部署 .env',
  fromProvider: '端点 .env',
  setLabel: '已填',
  unsetLabel: '未填',
  dir: '记录目录',
  indexFile: '索引文件',
  keep: '保留条数',
  lastItem: '最近转写',
  lastError: '最近错误',
  none: '无',
  runtime: '运行时',
  copyDir: '复制目录',
};

const EN = {
  listTitle: 'Transcripts',
  listEn: '',
  listDesc: 'Everything transcribed so far; copy the text or inspect the source. Source audio is never copied.',
  statusTitle: 'Status',
  statusEn: '',
  statusDesc: 'Endpoint, key and transcript folder.',
  refresh: 'Refresh',
  selfTest: 'Insert self-test record',
  selfTestDone: 'Self-test record written: save → index → page all work.',
  selfTestBad: 'Self-test failed',
  clearAll: 'Clear all',
  clearAsk: 'Clear every transcript?',
  clearBody: 'All transcript records are removed; source audio is untouched. This cannot be undone.',
  cleared: 'Cleared',
  remove: 'Delete',
  removeAsk: 'Delete this record?',
  removeBody: 'The record is removed; the source audio is untouched.',
  removed: 'Deleted',
  copyText: 'Copy text',
  copySource: 'Copy source',
  count: 'Transcripts',
  audioBytes: 'Audio seen',
  shown: 'Shown',
  connecting: 'Live feed disconnected',
  connected: 'Live feed connected',
  busier: 'Working…',
  empty: 'No transcripts yet. Ask the pet to transcribe one, or use "Insert self-test record" to check the chain.',
  loadBad: 'Could not read the transcript list',
  unknown: 'unknown',
  keyField: 'STT API key',
  keyHint: 'The key is written to .env.',
  keyPlaceholder: 'Paste the API key, then save',
  keyPlaceholderSet: 'Configured; paste a new one to replace it',
  keyEmpty: 'Paste the key first',
  keySaved: 'Key saved',
  keyCleared: 'Key cleared',
  clearKey: 'Clear key',
  clearKeyBody: 'Empties that line in .env. Transcription will fail until a key is entered again.',
  saveKey: 'Save key',
  testTitle: 'Test transcription',
  testDesc: 'Pick an audio file and transcribe it once with the current settings; it is kept in the list.',
  pickFile: 'Pick audio file',
  pickTitle: 'Pick an audio file to transcribe',
  pickNone: 'No file selected',
  pickEmpty: 'Pick an audio file first',
  pickRun: 'Transcribe',
  testDone: 'Transcribed',
  testBad: 'Transcription failed',
  noText: '(no speech recognized)',
  endpoint: 'Endpoint',
  protocol: 'Protocol',
  model: 'Model',
  langHint: 'Language hints',
  context: 'Context hint',
  keepDialect: 'Keep dialect',
  itn: 'ITN',
  sampleRate: 'Sample rate',
  maxMb: 'File cap',
  autoLabel: 'auto',
  onLabel: 'on',
  offLabel: 'off',
  timeout: 'Timeout',
  keyName: 'Secret name',
  keyState: 'API key',
  keyFrom: 'Key source',
  fromBot: 'deployment .env',
  fromProvider: 'endpoint .env',
  setLabel: 'set',
  unsetLabel: 'missing',
  dir: 'Transcript folder',
  indexFile: 'Index file',
  keep: 'Keep',
  lastItem: 'Latest',
  lastError: 'Last error',
  none: 'none',
  runtime: 'Runtime',
  copyDir: 'Copy folder',
};

const text = (language) => (language === 'en' ? EN : ZH);

/** 异常一律收敛成一行字。 */
function message(err) {
  if (err && typeof err === 'object' && 'message' in err) return String(err.message);
  return String(err);
}

function injectStyle(ctx) {
  const el = ctx.ui.h('style');
  el.textContent = STYLE;
  ctx.root.appendChild(el);
}

/** 一行预览：换行折叠，超长截断。 */
function preview(value, max = 90) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ---------------------------------------------------------------------------
// 转写页
// ---------------------------------------------------------------------------

function transcriptsPanel(ctx) {
  const tx = text(ctx.language);
  injectStyle(ctx);

  const sheet = ctx.ui.sheet({ title: tx.listTitle, en: tx.listEn || undefined, desc: tx.listDesc });
  ctx.root.appendChild(sheet.el);
  const body = sheet.body;

  const stats = ctx.ui.statgrid();
  body.appendChild(stats);

  const rowbar = ctx.ui.rowbar();
  const connBox = ctx.ui.h('div', 'st-conn');
  rowbar.appendChild(connBox);
  rowbar.appendChild(ctx.ui.h('span', 'grow'));
  body.appendChild(rowbar);

  const actions = ctx.ui.actions();
  body.appendChild(actions);

  const note = ctx.ui.msgline('');
  body.appendChild(note);

  const list = ctx.ui.h('div', 'st-list');
  body.appendChild(list);

  let focusId = '';
  let lastCount = -1;
  let seq = 0;

  const setConn = (label, tone) => {
    connBox.textContent = '';
    connBox.appendChild(ctx.ui.pill(label, tone));
  };
  const say = (line) => {
    note.textContent = line || '';
  };

  const render = (data) => {
    const items = Array.isArray(data?.items) ? data.items : [];
    lastCount = typeof data?.count === 'number' ? data.count : items.length;
    stats.replaceChildren(
      ctx.ui.stat({ k: tx.count, v: String(lastCount) }),
      ctx.ui.stat({ k: tx.audioBytes, v: ctx.ui.fmt.bytes(data?.totalAudioBytes ?? 0) }),
      ctx.ui.stat({ k: tx.shown, v: String(items.length) }),
    );
    list.replaceChildren();
    if (!items.length) {
      list.appendChild(ctx.ui.h('div', 'st-empty', tx.empty));
      return;
    }
    for (const item of items) list.appendChild(card(item));
    if (focusId) {
      const hit = list.querySelector(`[data-id="${focusId}"]`);
      if (hit) {
        hit.classList.add('st-hit');
        hit.scrollIntoView({ block: 'nearest' });
      }
      focusId = '';
    }
  };

  const card = (item) => {
    const el = ctx.ui.h('div', 'st-item');
    el.dataset.id = item.id;

    const source = item.source?.ref ? String(item.source.ref) : '';
    const head = ctx.ui.h('div', 'st-head');
    head.appendChild(ctx.ui.h('span', 'st-name', item.note || preview(item.text, 60) || item.id));
    if (source) head.appendChild(ctx.ui.h('span', 'st-sub', source));
    el.appendChild(head);

    const duration = typeof item.seconds === 'number' ? ctx.ui.fmt.duration(item.seconds * 1000) : '—';
    el.appendChild(ctx.ui.h('div', 'st-sub', [
      item.id,
      item.model || '—',
      item.language || '—',
      duration,
      item.audioBytes ? ctx.ui.fmt.bytes(item.audioBytes) : '—',
      ctx.ui.fmt.clock(item.createdAt),
    ].join(' · ')));

    if (item.text) el.appendChild(ctx.ui.h('div', 'st-text', item.text));
    else el.appendChild(ctx.ui.h('div', 'st-sub', tx.noText));

    const bar = ctx.ui.h('div', 'st-row');
    if (item.text) bar.appendChild(ctx.ui.copyButton(item.text, { label: tx.copyText }));
    if (source) bar.appendChild(ctx.ui.copyButton(source, { label: tx.copySource }));
    bar.appendChild(ctx.ui.button(tx.remove, { variant: 'danger', size: 'sm', onClick: () => { void drop(item); } }));
    el.appendChild(bar);
    return el;
  };

  const reload = async (busy) => {
    const mine = ++seq;
    const release = busy ? ctx.ui.busy(tx.busier, tx.refresh) : null;
    try {
      const data = await ctx.invoke('list', [120]);
      if (mine !== seq || ctx.signal.aborted) return;
      render(data);
      say('');
    } catch (err) {
      if (mine !== seq) return;
      say(`${tx.loadBad}：${message(err)}`);
      ctx.ui.toast(`${tx.loadBad}：${message(err)}`, 'bad');
    } finally {
      if (release) release.dispose();
    }
  };

  const drop = async (item) => {
    const ok = await ctx.ui.confirm({ title: tx.removeAsk, body: tx.removeBody, danger: true });
    if (!ok) return;
    try {
      await ctx.invoke('remove', [item.id]);
      await reload(false);
      ctx.ui.toast(tx.removed, 'ok');
    } catch (err) {
      ctx.ui.toast(message(err), 'bad');
    }
  };

  const clearAll = async () => {
    const ok = await ctx.ui.confirm({ title: tx.clearAsk, body: tx.clearBody, danger: true });
    if (!ok) return;
    try {
      await ctx.invoke('clear', []);
      await reload(false);
      ctx.ui.toast(tx.cleared, 'ok');
    } catch (err) {
      ctx.ui.toast(message(err), 'bad');
    }
  };

  const selfTest = async () => {
    const release = ctx.ui.busy(tx.busier, tx.selfTest);
    try {
      const res = await ctx.invoke('selftest', []);
      if (res?.item?.id) focusId = res.item.id;
      await reload(false);
      ctx.ui.toast(tx.selfTestDone, 'ok');
    } catch (err) {
      ctx.ui.toast(`${tx.selfTestBad}：${message(err)}`, 'bad');
    } finally {
      release.dispose();
    }
  };

  actions.append(
    ctx.ui.button(tx.refresh, { size: 'sm', onClick: () => { void reload(true); } }),
    ctx.ui.button(tx.selfTest, { size: 'sm', onClick: () => { void selfTest(); } }),
    ctx.ui.button(tx.clearAll, { variant: 'danger', size: 'sm', onClick: () => { void clearAll(); } }),
  );

  setConn(tx.connecting, 'plain');
  ctx.own(ctx.stream({
    open: () => setConn(tx.connected, 'on'),
    close: () => setConn(tx.connecting, 'off'),
    message: (raw) => {
      let frame = null;
      try {
        frame = JSON.parse(raw);
      } catch (e) {
        return;
      }
      if (!frame || typeof frame !== 'object') return;
      switch (frame.t) {
        case 'ready':
          setConn(`${tx.connected} · ${frame.count ?? 0}`, 'on');
          break;
        case 'item':
          if (frame.item?.id) focusId = frame.item.id;
          void reload(false);
          break;
        case 'removed':
        case 'cleared':
          void reload(false);
          break;
        case 'error':
          ctx.ui.toast(frame.message || tx.unknown, 'bad');
          break;
        default:
          break;
      }
    },
  }));

  // 推送关掉时页面也能自己追上：只在条数变了以后重建。
  ctx.interval(() => {
    ctx.invoke('list', [1])
      .then((data) => {
        if (typeof data?.count === 'number' && data.count !== lastCount) void reload(false);
      })
      .catch(() => { /* 面板自己会显示错误，这里别刷屏 */ });
  }, 30000);

  void reload(true);
}

// ---------------------------------------------------------------------------
// 状态页
// ---------------------------------------------------------------------------

function statusPanel(ctx) {
  const tx = text(ctx.language);
  injectStyle(ctx);

  const sheet = ctx.ui.sheet({ title: tx.statusTitle, en: tx.statusEn || undefined, desc: tx.statusDesc });
  ctx.root.appendChild(sheet.el);
  const body = sheet.body;

  const stats = ctx.ui.statgrid();
  body.appendChild(stats);

  const keyCard = ctx.ui.section(tx.keyField, tx.keyHint);
  const keyRow = ctx.ui.rowbar();
  const keyInput = ctx.ui.input({ type: 'password', placeholder: tx.keyPlaceholder, cls: 'mono' });
  keyInput.style.minWidth = '280px';
  keyRow.append(
    keyInput,
    ctx.ui.button(tx.saveKey, { variant: 'primary', size: 'sm', onClick: () => { void saveKey(); } }),
    ctx.ui.button(tx.clearKey, { size: 'sm', onClick: () => { void clearKey(); } }),
  );
  keyCard.appendChild(keyRow);
  body.appendChild(keyCard);

  const testCard = ctx.ui.section(tx.testTitle, tx.testDesc);
  const testRow = ctx.ui.h('div', 'st-testrow');
  const fileLine = ctx.ui.h('span', 'st-file mono', tx.pickNone);
  testRow.append(
    ctx.ui.button(tx.pickFile, { size: 'sm', onClick: () => { void pickFile(); } }),
    fileLine,
    ctx.ui.button(tx.pickRun, { variant: 'primary', size: 'sm', onClick: () => { void runTest(); } }),
  );
  testCard.appendChild(testRow);
  const testNote = ctx.ui.msgline('');
  testCard.appendChild(testNote);
  body.appendChild(testCard);

  const kvBox = ctx.ui.h('div');
  body.appendChild(kvBox);

  const actions = ctx.ui.actions();
  body.appendChild(actions);

  const note = ctx.ui.msgline('');
  body.appendChild(note);

  let currentDir = '';
  let testPath = '';

  const onOff = (value) => (value ? tx.onLabel : tx.offLabel);

  const render = (s) => {
    currentDir = String(s?.dir ?? '');
    stats.replaceChildren(
      ctx.ui.stat({ k: tx.count, v: String(s?.count ?? 0) }),
      ctx.ui.stat({ k: tx.keyState, v: ctx.ui.pill(s?.keySet ? tx.setLabel : tx.unsetLabel, s?.keySet ? 'on' : 'off') }),
      ctx.ui.stat({ k: tx.model, v: String(s?.model || '—') }),
      ctx.ui.stat({ k: tx.lastItem, v: s?.lastItemAt ? ctx.ui.fmt.clock(s.lastItemAt) : tx.none }),
    );
    kvBox.replaceChildren(ctx.ui.kv([
      { k: tx.protocol, v: s?.protocol || '—' },
      { k: tx.endpoint, v: s?.baseUrl || '—' },
      { k: tx.model, v: s?.model || '—' },
      { k: tx.langHint, v: s?.languageHints || tx.none },
      { k: tx.context, v: s?.context || tx.none },
      { k: tx.keepDialect, v: onOff(s?.keepDialect) },
      { k: tx.itn, v: onOff(s?.itn) },
      { k: tx.sampleRate, v: s?.sampleRate ? `${s.sampleRate} Hz` : tx.autoLabel },
      { k: tx.maxMb, v: `${s?.maxMb ?? 0} MB` },
      { k: tx.timeout, v: ctx.ui.fmt.duration(s?.timeoutMs ?? 0) },
      { k: tx.keyName, v: ctx.ui.h('span', 'mono', s?.keyName || '') },
      {
        k: tx.keyFrom,
        v: s?.keyFrom === 'bot'
          ? tx.fromBot
          : s?.keyFrom === 'provider'
            ? tx.fromProvider + (s?.keyProvider ? ` · ${s.keyProvider}` : '')
            : tx.none,
      },
      { k: tx.dir, v: ctx.ui.h('span', 'mono', currentDir) },
      { k: tx.indexFile, v: ctx.ui.h('span', 'mono', s?.indexFile || '') },
      { k: tx.keep, v: String(s?.keep ?? 0) },
      { k: tx.lastError, v: s?.lastError || tx.none },
      { k: tx.runtime, v: `Node ${s?.node ?? '?'} · ${s?.platform ?? '?'}` },
    ]));
    keyInput.placeholder = s?.keySet ? tx.keyPlaceholderSet : tx.keyPlaceholder;
  };

  const load = async (busy) => {
    const release = busy ? ctx.ui.busy(tx.busier, tx.statusTitle) : null;
    try {
      const s = await ctx.invoke('state', []);
      if (ctx.signal.aborted) return;
      render(s);
    } catch (err) {
      note.textContent = message(err);
      ctx.ui.toast(message(err), 'bad');
    } finally {
      if (release) release.dispose();
    }
  };

  const saveKey = async () => {
    const value = keyInput.value.trim();
    if (!value) {
      ctx.ui.toast(tx.keyEmpty, 'bad');
      return;
    }
    const release = ctx.ui.busy(tx.busier, tx.saveKey);
    try {
      const s = await ctx.invoke('setKey', [value]);
      keyInput.value = '';
      render(s);
      note.textContent = tx.keySaved;
      ctx.ui.toast(tx.keySaved, 'ok');
    } catch (err) {
      ctx.ui.toast(message(err), 'bad');
    } finally {
      release.dispose();
    }
  };

  const clearKey = async () => {
    const ok = await ctx.ui.confirm({ title: tx.clearKey, body: tx.clearKeyBody, danger: true });
    if (!ok) return;
    try {
      const s = await ctx.invoke('clearKey', []);
      render(s);
      note.textContent = tx.keyCleared;
      ctx.ui.toast(tx.keyCleared, 'ok');
    } catch (err) {
      ctx.ui.toast(message(err), 'bad');
    }
  };

  const pickFile = async () => {
    try {
      const picked = await ctx.pickPath({
        kind: 'file',
        title: tx.pickTitle,
        currentPath: testPath || undefined,
        extensions: ['.wav', '.mp3', '.m4a', '.ogg', '.opus', '.flac', '.aac', '.amr', '.webm'],
      });
      if (!picked) return;
      testPath = picked;
      fileLine.textContent = picked;
      fileLine.title = picked;
    } catch (err) {
      ctx.ui.toast(message(err), 'bad');
    }
  };

  const runTest = async () => {
    if (!testPath) {
      ctx.ui.toast(tx.pickEmpty, 'bad');
      return;
    }
    const release = ctx.ui.busy(tx.busier, tx.pickRun);
    try {
      const res = await ctx.invoke('test', [testPath]);
      const line = res?.item?.text ? preview(res.item.text) : tx.noText;
      testNote.textContent = `${tx.testDone} · ${line}`;
      ctx.ui.toast(tx.testDone, 'ok');
      await load(false);
    } catch (err) {
      testNote.textContent = `${tx.testBad}：${message(err)}`;
      ctx.ui.toast(`${tx.testBad}：${message(err)}`, 'bad');
    } finally {
      release.dispose();
    }
  };

  actions.append(
    ctx.ui.button(tx.refresh, { size: 'sm', onClick: () => { void load(true); } }),
    ctx.ui.copyButton(() => currentDir, { label: tx.copyDir }),
  );

  void load(true);
}

export default {
  panels: {
    transcripts: { mount: transcriptsPanel },
    status: { mount: statusPanel },
  },
};
