export function pcm16(samples) {
  const data = new ArrayBuffer(samples.length * 2);
  const view = new DataView(data);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return data;
}

export function wavHeader(samples, sampleRate) {
  const bytes = samples * 2;
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 0xffffffff - 36) throw new Error('فایل صوتی از ظرفیت قالب WAV بیشتر است.');
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  const write = (offset, text) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  write(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, bytes, true);
  return buffer;
}

export function makeWav(parts, samples, sampleRate) {
  const size = parts.reduce((sum, part) => sum + (part.size ?? part.byteLength), 0);
  if (size !== samples * 2) throw new Error('بخش‌های صوت کامل نیستند. لطفاً تولید را ادامه دهید.');
  return new Blob([wavHeader(samples, sampleRate), ...parts], {type: 'audio/wav'});
}
