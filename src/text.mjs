export const MAX_CHARACTERS = 120000;
export const CHUNK_SIZE = 220;
export const SAMPLE_TEXT = 'گاهی یک صدا، آغاز یک داستان تازه است. به استودیوی آوا خوش آمدید؛ جایی که کلمه‌ها جان می‌گیرند. متن فارسی خود را بنویسید، سرعت خواندن را تنظیم کنید و صدای خود را بسازید.';

const ones = ['صفر', 'یک', 'دو', 'سه', 'چهار', 'پنج', 'شش', 'هفت', 'هشت', 'نه', 'ده', 'یازده', 'دوازده', 'سیزده', 'چهارده', 'پانزده', 'شانزده', 'هفده', 'هجده', 'نوزده'];
const tens = ['', '', 'بیست', 'سی', 'چهل', 'پنجاه', 'شصت', 'هفتاد', 'هشتاد', 'نود'];
const hundreds = ['', 'صد', 'دویست', 'سیصد', 'چهارصد', 'پانصد', 'ششصد', 'هفتصد', 'هشتصد', 'نهصد'];
const scales = ['', 'هزار', 'میلیون', 'میلیارد', 'تریلیون'];

export function baseNormalize(text) {
  return String(text).normalize('NFC').replace(/[يى]/g, 'ی').replace(/ك/g, 'ک')
    .replace(/ـ/g, '').replace(/[\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export function asciiDigits(text) {
  return text.replace(/[۰-۹٠-٩]/g, digit => String(digit.charCodeAt(0) - (digit >= '۰' ? 1776 : 1632)));
}

function underThousand(number) {
  const parts = [];
  if (number >= 100) parts.push(hundreds[Math.floor(number / 100)]);
  number %= 100;
  if (number >= 20) {
    parts.push(tens[Math.floor(number / 10)]);
    number %= 10;
  }
  if (number) parts.push(ones[number]);
  return parts.join(' و ');
}

export function numberToPersian(value) {
  const text = asciiDigits(String(value)).replace(/[٬,]/g, '');
  if (!/^\d+$/.test(text)) return text;
  if (text.length > 15 || (text.length > 1 && text.startsWith('0'))) {
    return [...text].map(digit => ones[Number(digit)]).join(' ');
  }
  let number = Number(text);
  if (!number) return ones[0];
  const parts = [];
  let scale = 0;
  while (number) {
    const group = number % 1000;
    if (group) parts.unshift(scale === 1 && group === 1 ? 'هزار' : `${underThousand(group)}${scales[scale] ? ` ${scales[scale]}` : ''}`);
    number = Math.floor(number / 1000);
    scale++;
  }
  return parts.join(' و ');
}

export function expandNumbers(text) {
  return asciiDigits(text).replace(/\d{1,3}(?:[٬,]\d{3})+(?!\d)/g, number => number.replace(/[٬,]/g, ''))
    .replace(/\d+(?:[.٫]\d+)?/g, number => {
      const [integer, decimal] = number.split(/[.٫]/);
      return numberToPersian(integer) + (decimal ? ` ممیز ${numberToPersian(decimal)}` : '');
    }).replace(/[%٪]/g, ' درصد ');
}

export function parsePronunciations(value) {
  const entries = [];
  const seen = new Set();
  for (const line of value.split('\n')) {
    if (!line.trim()) continue;
    const separator = line.indexOf('=');
    const word = baseNormalize(line.slice(0, separator));
    const reading = baseNormalize(line.slice(separator + 1));
    if (separator < 1 || !word || !reading || word.length > 80 || reading.length > 160) {
      throw new Error('هر تلفظ را در یک خط به شکل «واژه = تلفظ» بنویسید؛ واژه تا ۸۰ و تلفظ تا ۱۶۰ نویسه.');
    }
    if (seen.has(word)) throw new Error(`برای «${word}» بیش از یک تلفظ نوشته شده است.`);
    seen.add(word);
    entries.push({word, reading});
    if (entries.length > 100) throw new Error('در هر پروژه حداکثر ۱۰۰ اصلاح تلفظ وارد کنید.');
  }
  return entries;
}

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function applyPronunciations(text, entries) {
  if (!entries.length) return text;
  const readings = new Map(entries.map(entry => [entry.word, entry.reading]));
  const words = [...readings.keys()].sort((a, b) => b.length - a.length).map(escapeRegex).join('|');
  const boundary = '[\\p{L}\\p{N}\\p{M}\\u200c]';
  return text.replace(new RegExp(`(?<!${boundary})(?:${words})(?!${boundary})`, 'gu'), word => readings.get(word));
}

export function prepareText(source, {numbers = true, pronunciations = ''} = {}) {
  let text = applyPronunciations(baseNormalize(source), parsePronunciations(pronunciations));
  if (numbers) text = expandNumbers(text);
  return text.replace(/\u200c/g, ' ').replace(/،/g, ',').replace(/؛/g, ';').replace(/؟/g, '?')
    .replace(/…/g, '...').replace(/[«»]/g, '"').trim();
}

// Preserve every word and punctuation mark; bound even a single unbroken token.
export function splitText(text, maxLength = CHUNK_SIZE) {
  if (!Number.isInteger(maxLength) || maxLength < 16) throw new Error('Invalid chunk size');
  const sentences = text.match(/[^.!?؟؛;\n]+(?:[.!?؟؛;]+|\n+|$)|[.!?؟؛;]+/gu) || [];
  const chunks = [];
  for (const sentence of sentences) {
    let current = '';
    for (const token of sentence.trim().match(/\S+/gu) || []) {
      if (current && current.length + token.length + 1 > maxLength) {
        chunks.push(current);
        current = '';
      }
      const letters = [...token];
      while (letters.join('').length > maxLength) {
        let piece = '';
        while (letters.length && piece.length + letters[0].length <= maxLength) piece += letters.shift();
        chunks.push(piece);
      }
      const remainder = letters.join('');
      if (remainder) current += (current ? ' ' : '') + remainder;
    }
    if (current) chunks.push(current);
  }
  return chunks;
}

export const wordCount = text => (text.trim().match(/\S+/gu) || []).length;
export const estimateSeconds = (text, speed = 1) => Math.ceil(wordCount(text) / (145 * speed) * 60);
export function formatTime(seconds) {
  const value = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}
