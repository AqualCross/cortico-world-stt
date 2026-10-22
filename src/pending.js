/**
 * 异步转写的在途任务表：`<dir>/pending.json`。
 *
 * 只存轮询与落记录需要的东西（任务号、模型、来源、期限），不存密钥。
 * 进程重启后接着查，所以写索引同样走「临时文件 → rename」。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'pending.json';
const VERSION = 1;
/** 在途任务不该无限堆积；超出时保留最新的这些。 */
const MAX_TASKS = 50;

function text(value, max = 500) {
  return String(value ?? '').slice(0, max);
}

function isoOrEmpty(value) {
  const s = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}T/.test(s) ? s : '';
}

/** 把外部数据收敛成固定形状；坏条目直接丢。 */
function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const taskId = text(raw.taskId, 200).trim();
  const id = text(raw.id, 40).trim() || taskId;
  if (!id) return null;
  const kind = raw.kind === 'request' ? 'request' : 'task';
  if (kind === 'task' && !taskId) return null;
  const audio = raw.audio && typeof raw.audio === 'object' ? raw.audio : {};
  return {
    id,
    kind,
    taskId,
    model: text(raw.model, 200),
    note: text(raw.note, 200),
    source: {
      kind: text(raw.source?.kind, 20) || 'file',
      ref: text(raw.source?.ref, 500),
    },
    audio: {
      name: text(audio.name, 300),
      bytes: Math.max(0, Math.round(Number(audio.bytes) || 0)),
      mime: text(audio.mime, 100),
      format: text(audio.format, 20),
      seconds: Number.isFinite(Number(audio.seconds)) && Number(audio.seconds) > 0 ? Number(audio.seconds) : null,
    },
    submittedAt: isoOrEmpty(raw.submittedAt),
    deadlineAt: isoOrEmpty(raw.deadlineAt),
    baseUrl: text(raw.baseUrl, 500),
    languageHints: Array.isArray(raw.languageHints)
      ? raw.languageHints.map((s) => text(s, 20).trim()).filter(Boolean).slice(0, 4)
      : [],
  };
}

export class PendingTasks {
  #items = null;

  constructor(opts = {}) {
    this.dir = String(opts.dir ?? '.');
  }

  get file() {
    return join(this.dir, FILE);
  }

  ensure() {
    mkdirSync(this.dir, { recursive: true });
    return this.dir;
  }

  #load() {
    if (this.#items) return this.#items;
    this.#items = [];
    try {
      if (!existsSync(this.file)) return this.#items;
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      const list = Array.isArray(parsed) ? parsed : parsed?.tasks;
      if (Array.isArray(list)) this.#items = list.map(normalize).filter(Boolean).slice(-MAX_TASKS);
    } catch {
      // 坏文件当空：少了在途任务，不该把整个 World 卡死。
    }
    return this.#items;
  }

  #save() {
    mkdirSync(this.dir, { recursive: true });
    const body = JSON.stringify({ version: VERSION, tasks: this.#load() }, null, 1);
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, body);
    renameSync(tmp, this.file);
  }

  get count() {
    return this.#load().length;
  }

  list() {
    return this.#load().map((item) => structuredClone(item));
  }

  add(raw) {
    const entry = normalize(raw);
    if (!entry) throw new Error('在途任务缺 id');
    const items = this.#load();
    const at = items.findIndex((it) => it.id === entry.id);
    if (at >= 0) items[at] = entry;
    else items.push(entry);
    while (items.length > MAX_TASKS) items.shift();
    this.#save();
    return structuredClone(entry);
  }

  remove(id) {
    const items = this.#load();
    const at = items.findIndex((it) => it.id === id);
    if (at < 0) return false;
    items.splice(at, 1);
    this.#save();
    return true;
  }
}
