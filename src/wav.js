/**
 * WAV 的小工具：读时长与采样率、造测试样本。
 *
 * 只认标准的 RIFF/WAVE（fmt + data），PCM 与 IEEE float 都按位深推算；
 * 认不出来就返回 null，调用方别据此编一个假值。
 */

/** 从 WAV 头里读信息；不是能认的 WAV 就返回 null。 */
export function wavInfo(bytes) {
  if (!bytes || bytes.length < 44) return null;
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12;
  let fmt = null;
  let dataBytes = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= b.length) {
      fmt = {
        channels: b.readUInt16LE(body + 2),
        sampleRate: b.readUInt32LE(body + 4),
        bits: b.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataBytes = Math.min(size, Math.max(0, b.length - body));
    }
    // 块按字对齐：奇数长度后面补一个 0 字节。
    off = body + size + (size % 2);
  }
  if (!fmt || !fmt.channels || !fmt.sampleRate || !fmt.bits || !dataBytes) return null;
  const bytesPerSecond = fmt.sampleRate * fmt.channels * (fmt.bits / 8);
  if (!bytesPerSecond) return null;
  return {
    seconds: dataBytes / bytesPerSecond,
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bits: fmt.bits,
  };
}

/** 从 WAV 头里读时长（秒）；不是能认的 WAV 就返回 null。 */
export function wavDuration(bytes) {
  return wavInfo(bytes)?.seconds ?? null;
}

/** 时长文案：一位小数。`null` 调用方自己写占位。 */
export function formatSeconds(seconds) {
  return `${Number(seconds).toFixed(1)} 秒`;
}

/** KB 文案：小于 100 KB 保留一位小数，回执与面板共用。 */
export function formatKb(bytes) {
  const n = Number(bytes) || 0;
  return n >= 102400 ? `${Math.round(n / 1024)} KB` : `${(n / 1024).toFixed(1)} KB`;
}

/**
 * 测试样本：一段低音量 440 Hz 正弦，16-bit 单声道 PCM。
 * 不联网、不依赖任何东西，只为验证「读文件 → 识别 → 记录 → 页面」这条路。
 */
export function sampleWav(seconds = 0.6, opts = {}) {
  const sampleRate = Number(opts.sampleRate) > 0 ? Number(opts.sampleRate) : 24000;
  const freq = Number(opts.freq) > 0 ? Number(opts.freq) : 440;
  const total = Math.max(1, Math.round(sampleRate * Math.min(Math.max(Number(seconds) || 0.6, 0.05), 5)));
  const bytes = Buffer.alloc(44 + total * 2);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(36 + total * 2, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); // PCM
  bytes.writeUInt16LE(1, 22); // mono
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28); // byte rate
  bytes.writeUInt16LE(2, 32); // block align
  bytes.writeUInt16LE(16, 34); // bits
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(total * 2, 40);
  const fade = Math.max(1, Math.round(sampleRate * 0.02));
  for (let i = 0; i < total; i += 1) {
    const edge = Math.min(1, i / fade, (total - 1 - i) / fade);
    const value = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.25 * edge;
    bytes.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  return bytes;
}
