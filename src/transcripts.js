/**
 * 转写记录仓库：一个目录 + 一份 index.json，只存文本与元数据。
 *
 * **不复制源音频**：记录里的 `source.ref` 只是当初的路径或句柄，源文件删了
 * 记录也照在。写索引走「写临时文件再 rename」；索引损坏时静默当空，
 * 避免一个坏文件把整个 World 卡死。
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const INDEX_FILE = 'index.json';
const VERSION = 1;

function newId() {
  return randomBytes(4).toString('hex');
}

function intOf(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}

function secondsOf(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

/** 来源描述：路径 / 句柄 / 自检；只留 kind 与 ref，够面板与回执用。 */
function sourceOf(value) {
  if (!value || typeof value !== 'object') return { kind: 'file', ref: '' };
  const kind = ['file', 'handle', 'selftest', 'live', 'console-test'].includes(value.kind) ? value.kind : 'file';
  return { kind, ref: String(value.ref ?? '').slice(0, 500) };
}

export class Transcripts {
  #items = [];
  #loaded = false;

  /** @param {{dir: string, keep?: number}} opts */
  constructor(opts = {}) {
    this.dir = String(opts.dir ?? '.');
    this.keep = intOf(opts.keep, 200);
  }

  get indexFile() {
    return join(this.dir, INDEX_FILE);
  }

  ensure() {
    mkdirSync(this.dir, { recursive: true });
    return this.dir;
  }

  get count() {
    this.#load();
    return this.#items.length;
  }

  /** 记录里提到过的源音频总大小（不占磁盘，只作面板读数）。 */
  get totalAudioBytes() {
    this.#load();
    return this.#items.reduce((sum, item) => sum + intOf(item.audioBytes), 0);
  }

  list(limit = 24) {
    this.#load();
    const n = Math.max(0, intOf(limit, 24));
    return this.#items.slice(0, n || this.#items.length).map((item) => ({ ...item }));
  }

  get(ref) {
    this.#load();
    const key = String(ref ?? '').trim().toLowerCase();
    if (!key) return null;
    const item = this.#items.find((it) => it.id.toLowerCase() === key);
    return item ? { ...item } : null;
  }

  /** 存一条记录并返回它。 */
  add(entry) {
    this.#load();
    this.ensure();
    const item = {
      id: newId(),
      text: String(entry.text ?? '').slice(0, 20000),
      note: String(entry.note ?? '').slice(0, 200),
      source: sourceOf(entry.source),
      model: String(entry.model ?? '').slice(0, 200),
      protocol: String(entry.protocol ?? ''),
      language: String(entry.language ?? '').slice(0, 40),
      seconds: secondsOf(entry.seconds),
      audioBytes: intOf(entry.audioBytes),
      audioMime: String(entry.audioMime ?? ''),
      format: String(entry.format ?? ''),
      usage: entry.usage && typeof entry.usage === 'object' ? entry.usage : null,
      createdAt: new Date().toISOString(),
    };
    this.#items.unshift(item);
    this.#prune();
    this.#save();
    return { ...item };
  }

  remove(ref) {
    this.#load();
    const item = this.get(ref);
    if (!item) return false;
    this.#items = this.#items.filter((it) => it.id !== item.id);
    this.#save();
    return true;
  }

  clear() {
    this.#load();
    const removed = this.#items.length;
    this.#items = [];
    this.#save();
    return removed;
  }

  summary(limit = 60) {
    this.#load();
    const n = Math.max(1, intOf(limit, 60));
    return {
      dir: this.dir,
      indexFile: this.indexFile,
      keep: this.keep,
      count: this.#items.length,
      totalAudioBytes: this.totalAudioBytes,
      shown: Math.min(n, this.#items.length),
      items: this.#items.slice(0, n).map((item) => ({ ...item })),
    };
  }

  #prune() {
    if (!this.keep || this.#items.length <= this.keep) return;
    this.#items.splice(this.keep);
  }

  #load() {
    if (this.#loaded) return;
    this.#loaded = true;
    const file = this.indexFile;
    if (!existsSync(file)) {
      this.#items = [];
      return;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      parsed = null;
    }
    const raw = Array.isArray(parsed) ? parsed : parsed?.items;
    if (!Array.isArray(raw)) {
      this.#items = [];
      return;
    }
    const items = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      items.push({
        id: typeof entry.id === 'string' && entry.id ? entry.id : newId(),
        text: String(entry.text ?? ''),
        note: String(entry.note ?? ''),
        source: sourceOf(entry.source),
        model: String(entry.model ?? ''),
        protocol: String(entry.protocol ?? ''),
        language: String(entry.language ?? ''),
        seconds: secondsOf(entry.seconds),
        audioBytes: intOf(entry.audioBytes),
        audioMime: String(entry.audioMime ?? ''),
        format: String(entry.format ?? ''),
        usage: entry.usage && typeof entry.usage === 'object' ? entry.usage : null,
        createdAt: String(entry.createdAt ?? new Date().toISOString()),
      });
    }
    this.#items = items;
    const before = items.length;
    this.#prune();
    if (this.#items.length !== before) this.#save();
  }

  #save() {
    try {
      this.ensure();
      const body = JSON.stringify({ version: VERSION, items: this.#items }, null, 2);
      const tmp = `${this.indexFile}.tmp`;
      writeFileSync(tmp, body);
      renameSync(tmp, this.indexFile);
    } catch {
      /* 磁盘写不进去时不打断转写；下一次成功写入会覆盖。 */
    }
  }
}
