const MP3_BITRATE_KBPS: Record<string, number[]> = {
  'mpeg1-layer1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  'mpeg1-layer2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  'mpeg1-layer3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  'mpeg2-layer1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  'mpeg2-layer2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  'mpeg2-layer3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

const MPEG_SAMPLE_RATES: Record<number, number[]> = {
  0: [11025, 12000, 8000],
  2: [22050, 24000, 16000],
  3: [44100, 48000, 32000],
};

const AAC_SAMPLE_RATES = [
  96000,
  88200,
  64000,
  48000,
  44100,
  32000,
  24000,
  22050,
  16000,
  12000,
  11025,
  8000,
  7350,
];

const ISO_CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta']);

export const MINIMAX_H3_REFERENCE_AUDIO_MIN_SECONDS = 2;
export const MINIMAX_H3_REFERENCE_AUDIO_MAX_SECONDS = 15;
export const MINIMAX_H3_REFERENCE_VIDEO_MIN_SECONDS = 2;
export const MINIMAX_H3_REFERENCE_VIDEO_MAX_SECONDS = 15;

type ReferenceMediaKind = 'video' | 'audio';

export type MediaDurationValidation = {
  ok: boolean;
  durationSeconds?: number;
  error?: string;
};

function isUsableDuration(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function getFilenameExtension(filename?: string): string {
  const match = filename?.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || '';
}

function parseWavDuration(buffer: Buffer): number | null {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }

  let offset = 12;
  let byteRate = 0;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + chunkSize > buffer.length) break;

    if (chunkId === 'fmt ' && chunkSize >= 16) {
      channels = buffer.readUInt16LE(dataOffset + 2);
      sampleRate = buffer.readUInt32LE(dataOffset + 4);
      byteRate = buffer.readUInt32LE(dataOffset + 8);
      bitsPerSample = buffer.readUInt16LE(dataOffset + 14);
    } else if (chunkId === 'data') {
      dataSize += chunkSize;
    }

    offset = dataOffset + chunkSize + (chunkSize % 2);
  }

  const bytesPerSecond = byteRate || (sampleRate * channels * bitsPerSample) / 8;
  return bytesPerSecond > 0 && dataSize > 0 ? dataSize / bytesPerSecond : null;
}

function skipId3v2(buffer: Buffer): number {
  if (buffer.length < 10 || buffer.toString('ascii', 0, 3) !== 'ID3') return 0;
  const size =
    ((buffer[6] & 0x7f) << 21) |
    ((buffer[7] & 0x7f) << 14) |
    ((buffer[8] & 0x7f) << 7) |
    (buffer[9] & 0x7f);
  return Math.min(buffer.length, 10 + size);
}

type Mp3FrameInfo = {
  bitrateKbps: number;
  frameLength: number;
  sampleRate: number;
  samplesPerFrame: number;
};

function parseMp3FrameHeader(buffer: Buffer, offset: number): Mp3FrameInfo | null {
  if (offset + 4 > buffer.length || buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) {
    return null;
  }

  const header = buffer.readUInt32BE(offset);
  const version = (header >> 19) & 0x3;
  const layer = (header >> 17) & 0x3;
  const bitrateIndex = (header >> 12) & 0xf;
  const sampleRateIndex = (header >> 10) & 0x3;
  const padding = (header >> 9) & 0x1;

  if (version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
    return null;
  }

  const versionKey = version === 3 ? 'mpeg1' : 'mpeg2';
  const layerName = layer === 3 ? 'layer1' : layer === 2 ? 'layer2' : 'layer3';
  const bitrateKbps = MP3_BITRATE_KBPS[`${versionKey}-${layerName}`]?.[bitrateIndex] || 0;
  const sampleRate = MPEG_SAMPLE_RATES[version]?.[sampleRateIndex] || 0;
  if (!bitrateKbps || !sampleRate) return null;

  const samplesPerFrame = layer === 3 ? 384 : layer === 2 || version === 3 ? 1152 : 576;
  const bitrate = bitrateKbps * 1000;
  const frameLength =
    layer === 3
      ? Math.floor((12 * bitrate) / sampleRate + padding) * 4
      : Math.floor(((layer === 1 && version !== 3 ? 72 : 144) * bitrate) / sampleRate + padding);

  return frameLength > 4 ? { bitrateKbps, frameLength, sampleRate, samplesPerFrame } : null;
}

function parseMp3Duration(buffer: Buffer): number | null {
  let offset = skipId3v2(buffer);
  const end = buffer.length >= 128 && buffer.toString('ascii', buffer.length - 128, buffer.length - 125) === 'TAG'
    ? buffer.length - 128
    : buffer.length;
  let frames = 0;
  let samples = 0;
  let sampleRate = 0;

  while (offset + 4 <= end) {
    const frame = parseMp3FrameHeader(buffer, offset);
    if (!frame || offset + frame.frameLength > end) {
      offset += 1;
      continue;
    }

    frames += 1;
    samples += frame.samplesPerFrame;
    sampleRate = frame.sampleRate;
    offset += frame.frameLength;
  }

  return frames > 0 && sampleRate > 0 ? samples / sampleRate : null;
}

function parseAdtsAacDuration(buffer: Buffer): number | null {
  let offset = 0;
  let frames = 0;
  let sampleRate = 0;

  while (offset + 7 <= buffer.length) {
    if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xf0) !== 0xf0) {
      offset += 1;
      continue;
    }

    const sampleRateIndex = (buffer[offset + 2] >> 2) & 0xf;
    const frameLength = ((buffer[offset + 3] & 0x3) << 11) | (buffer[offset + 4] << 3) | ((buffer[offset + 5] & 0xe0) >> 5);
    const parsedSampleRate = AAC_SAMPLE_RATES[sampleRateIndex] || 0;
    if (!parsedSampleRate || frameLength < 7 || offset + frameLength > buffer.length) {
      offset += 1;
      continue;
    }

    frames += 1;
    sampleRate = parsedSampleRate;
    offset += frameLength;
  }

  return frames > 0 && sampleRate > 0 ? (frames * 1024) / sampleRate : null;
}

function readUInt64BEAsNumber(buffer: Buffer, offset: number): number | null {
  if (offset + 8 > buffer.length) return null;
  const value = buffer.readBigUInt64BE(offset);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function parseIsoDurationBox(buffer: Buffer, payloadOffset: number, payloadEnd: number): number | null {
  if (payloadOffset + 20 > payloadEnd) return null;
  const version = buffer[payloadOffset];

  if (version === 1) {
    if (payloadOffset + 32 > payloadEnd) return null;
    const timescale = buffer.readUInt32BE(payloadOffset + 20);
    const duration = readUInt64BEAsNumber(buffer, payloadOffset + 24);
    return timescale > 0 && duration ? duration / timescale : null;
  }

  const timescale = buffer.readUInt32BE(payloadOffset + 12);
  const duration = buffer.readUInt32BE(payloadOffset + 16);
  return timescale > 0 && duration > 0 ? duration / timescale : null;
}

function parseIsoBmffDuration(buffer: Buffer, start = 0, end = buffer.length, depth = 0): number | null {
  if (depth > 6) return null;

  let offset = start;
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    let headerSize = 8;

    if (size === 1) {
      const largeSize = readUInt64BEAsNumber(buffer, offset + 8);
      if (!largeSize) break;
      size = largeSize;
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }

    const boxEnd = offset + size;
    if (size < headerSize || boxEnd > end) break;

    if (type === 'mvhd' || type === 'mdhd') {
      const duration = parseIsoDurationBox(buffer, offset + headerSize, boxEnd);
      if (isUsableDuration(duration)) return duration;
    }

    if (ISO_CONTAINER_BOXES.has(type)) {
      const duration = parseIsoBmffDuration(buffer, offset + headerSize, boxEnd, depth + 1);
      if (isUsableDuration(duration)) return duration;
    }

    offset = boxEnd;
  }

  return null;
}

function readOggSampleRate(buffer: Buffer): number | null {
  const opusOffset = buffer.indexOf('OpusHead', 0, 'ascii');
  if (opusOffset >= 0) return 48000;

  const vorbisOffset = buffer.indexOf('\x01vorbis', 0, 'binary');
  if (vorbisOffset >= 0 && vorbisOffset + 16 <= buffer.length) {
    const sampleRate = buffer.readUInt32LE(vorbisOffset + 12);
    return sampleRate > 0 ? sampleRate : null;
  }

  return null;
}

function parseOggDuration(buffer: Buffer): number | null {
  const sampleRate = readOggSampleRate(buffer);
  if (!sampleRate) return null;

  let offset = 0;
  let maxGranule = BigInt(0);

  while (offset + 27 <= buffer.length) {
    if (buffer.toString('ascii', offset, offset + 4) !== 'OggS') {
      offset += 1;
      continue;
    }

    const pageSegments = buffer[offset + 26];
    if (offset + 27 + pageSegments > buffer.length) break;
    let payloadSize = 0;
    for (let index = 0; index < pageSegments; index += 1) {
      payloadSize += buffer[offset + 27 + index];
    }

    const granule = buffer.readBigUInt64LE(offset + 6);
    if (granule !== BigInt('0xffffffffffffffff') && granule > maxGranule) {
      maxGranule = granule;
    }

    offset += 27 + pageSegments + payloadSize;
  }

  return maxGranule > BigInt(0) ? Number(maxGranule) / sampleRate : null;
}

function readEbmlVint(buffer: Buffer, offset: number): { length: number; value: number; nextOffset: number } | null {
  if (offset >= buffer.length) return null;
  const first = buffer[offset];
  let mask = 0x80;
  let length = 1;

  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }

  if (length > 8 || offset + length > buffer.length) return null;

  let value = first & (mask - 1);
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + buffer[offset + index];
  }

  return { length, value, nextOffset: offset + length };
}

function readEbmlUnsigned(buffer: Buffer, offset: number, size: number): number | null {
  if (size < 1 || size > 6 || offset + size > buffer.length) return null;
  let value = 0;
  for (let index = 0; index < size; index += 1) {
    value = value * 256 + buffer[offset + index];
  }
  return value;
}

function readEbmlFloat(buffer: Buffer, offset: number, size: number): number | null {
  if (offset + size > buffer.length) return null;
  if (size === 4) return buffer.readFloatBE(offset);
  if (size === 8) return buffer.readDoubleBE(offset);
  return null;
}

function readKnownEbmlElement(buffer: Buffer, id: number[]): { payloadOffset: number; payloadSize: number } | null {
  let offset = buffer.indexOf(Buffer.from(id));
  while (offset >= 0) {
    const size = readEbmlVint(buffer, offset + id.length);
    if (size && size.value > 0 && size.nextOffset + size.value <= buffer.length) {
      return { payloadOffset: size.nextOffset, payloadSize: size.value };
    }
    offset = buffer.indexOf(Buffer.from(id), offset + 1);
  }
  return null;
}

function parseWebmDuration(buffer: Buffer): number | null {
  const scaleElement = readKnownEbmlElement(buffer, [0x2a, 0xd7, 0xb1]);
  const durationElement = readKnownEbmlElement(buffer, [0x44, 0x89]);
  if (!durationElement) return null;

  const timecodeScale =
    scaleElement ? readEbmlUnsigned(buffer, scaleElement.payloadOffset, scaleElement.payloadSize) || 1000000 : 1000000;
  const duration = readEbmlFloat(buffer, durationElement.payloadOffset, durationElement.payloadSize);

  return isUsableDuration(duration) ? (duration * timecodeScale) / 1_000_000_000 : null;
}

function parseM3u8Duration(buffer: Buffer): number | null {
  const text = buffer.toString('utf8');
  if (!text.includes('#EXTM3U')) return null;

  const matches = Array.from(text.matchAll(/^#EXTINF:([0-9]+(?:\.[0-9]+)?)/gim));
  if (matches.length === 0) return null;

  const duration = matches.reduce((total, match) => total + Number(match[1] || 0), 0);
  return duration > 0 ? duration : null;
}

export function detectAudioDurationSeconds(buffer: Buffer, mimeType: string, filename?: string): number | null {
  const normalizedMimeType = mimeType.split(';')[0]?.trim().toLowerCase() || '';
  const extension = getFilenameExtension(filename);
  const parsers: Array<() => number | null> = [];

  if (normalizedMimeType.includes('wav') || extension === 'wav') parsers.push(() => parseWavDuration(buffer));
  if (normalizedMimeType.includes('mpeg') || normalizedMimeType.includes('mp3') || extension === 'mp3') {
    parsers.push(() => parseMp3Duration(buffer));
  }
  if (normalizedMimeType.includes('aac') || extension === 'aac') parsers.push(() => parseAdtsAacDuration(buffer));
  if (normalizedMimeType.includes('mp4') || extension === 'm4a' || extension === 'mp4') {
    parsers.push(() => parseIsoBmffDuration(buffer));
  }
  if (normalizedMimeType.includes('ogg') || extension === 'ogg' || extension === 'oga') {
    parsers.push(() => parseOggDuration(buffer));
  }
  if (normalizedMimeType.includes('webm') || extension === 'webm') parsers.push(() => parseWebmDuration(buffer));

  parsers.push(
    () => parseWavDuration(buffer),
    () => parseMp3Duration(buffer),
    () => parseAdtsAacDuration(buffer),
    () => parseIsoBmffDuration(buffer),
    () => parseOggDuration(buffer),
    () => parseWebmDuration(buffer)
  );

  for (const parser of parsers) {
    const duration = parser();
    if (isUsableDuration(duration)) return duration;
  }

  return null;
}

export function detectVideoDurationSeconds(buffer: Buffer, mimeType: string, filename?: string): number | null {
  const normalizedMimeType = mimeType.split(';')[0]?.trim().toLowerCase() || '';
  const extension = getFilenameExtension(filename);
  const parsers: Array<() => number | null> = [];

  if (
    normalizedMimeType.includes('mp4') ||
    normalizedMimeType.includes('quicktime') ||
    extension === 'mp4' ||
    extension === 'mov'
  ) {
    parsers.push(() => parseIsoBmffDuration(buffer));
  }
  if (
    normalizedMimeType.includes('webm') ||
    normalizedMimeType.includes('matroska') ||
    extension === 'webm' ||
    extension === 'mkv'
  ) {
    parsers.push(() => parseWebmDuration(buffer));
  }
  if (
    normalizedMimeType.includes('mpegurl') ||
    extension === 'm3u8'
  ) {
    parsers.push(() => parseM3u8Duration(buffer));
  }

  parsers.push(
    () => parseIsoBmffDuration(buffer),
    () => parseWebmDuration(buffer),
    () => parseM3u8Duration(buffer)
  );

  for (const parser of parsers) {
    const duration = parser();
    if (isUsableDuration(duration)) return duration;
  }

  return null;
}

export function validateMinimaxH3ReferenceAudioDuration(
  buffer: Buffer,
  mimeType: string,
  filename?: string
): MediaDurationValidation {
  const durationSeconds = detectAudioDurationSeconds(buffer, mimeType, filename);
  if (!isUsableDuration(durationSeconds)) {
    return {
      ok: false,
      error: '无法读取参考音频时长，请上传 MP3、WAV、M4A、AAC、OGG 或 WebM 音频。',
    };
  }

  if (
    durationSeconds < MINIMAX_H3_REFERENCE_AUDIO_MIN_SECONDS ||
    durationSeconds > MINIMAX_H3_REFERENCE_AUDIO_MAX_SECONDS
  ) {
    return {
      ok: false,
      durationSeconds,
      error: `参考音频时长需在 ${MINIMAX_H3_REFERENCE_AUDIO_MIN_SECONDS}～${MINIMAX_H3_REFERENCE_AUDIO_MAX_SECONDS} 秒之间，当前检测为 ${durationSeconds.toFixed(2)} 秒。`,
    };
  }

  return { ok: true, durationSeconds };
}

export function validateMinimaxH3ReferenceVideoDuration(
  buffer: Buffer,
  mimeType: string,
  filename?: string
): MediaDurationValidation {
  const durationSeconds = detectVideoDurationSeconds(buffer, mimeType, filename);
  if (!isUsableDuration(durationSeconds)) {
    return {
      ok: false,
      error: '无法读取参考视频时长，请上传 MP4、MOV、WebM、MKV 或 M3U8 视频。',
    };
  }

  if (
    durationSeconds < MINIMAX_H3_REFERENCE_VIDEO_MIN_SECONDS ||
    durationSeconds > MINIMAX_H3_REFERENCE_VIDEO_MAX_SECONDS
  ) {
    return {
      ok: false,
      durationSeconds,
      error: `参考视频时长需在 ${MINIMAX_H3_REFERENCE_VIDEO_MIN_SECONDS}～${MINIMAX_H3_REFERENCE_VIDEO_MAX_SECONDS} 秒之间，当前检测为 ${durationSeconds.toFixed(2)} 秒。`,
    };
  }

  return { ok: true, durationSeconds };
}

export function validateMinimaxH3ReferenceMediaDuration(
  kind: ReferenceMediaKind,
  buffer: Buffer,
  mimeType: string,
  filename?: string
): MediaDurationValidation {
  return kind === 'video'
    ? validateMinimaxH3ReferenceVideoDuration(buffer, mimeType, filename)
    : validateMinimaxH3ReferenceAudioDuration(buffer, mimeType, filename);
}
