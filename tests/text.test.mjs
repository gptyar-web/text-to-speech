import {test} from 'node:test';
import assert from 'node:assert/strict';
import {baseNormalize, asciiDigits, numberToPersian, expandNumbers, prepareText, splitText, parsePronunciations, applyPronunciations, estimateSeconds} from '../src/text.mjs';
import {pcm16, wavHeader, makeWav} from '../src/audio.mjs';

test('Persian normalization preserves vowel marks and word content', () => {
  assert.equal(baseNormalize('  كتاب\u200f  مِهر\r\nمي‌خوانم  '), 'کتاب مِهر\nمی‌خوانم');
  assert.equal(asciiDigits('۰۱۲٣٤٥۶۷۸۹'), '0123456789');
  assert.equal(prepareText('سلام، دنيا!'), 'سلام, دنیا!');
});

test('Persian cardinal numbers, fractions and leading zero identifiers', () => {
  assert.equal(numberToPersian('۱۴۰۵'), 'هزار و چهارصد و پنج');
  assert.equal(numberToPersian('۱۰۰۰۰۰۰'), 'یک میلیون');
  assert.equal(numberToPersian('۰۹۱۲'), 'صفر نه یک دو');
  assert.equal(numberToPersian('۱۸'), 'هجده');
  assert.equal(expandNumbers('۱٬۲۳۴ و ۳٫۱۴ و ۵۰٪'), 'هزار و دویست و سی و چهار و سه ممیز چهارده و پنجاه درصد ');
});

test('Pronunciation rules match whole Unicode words without cascading or regex execution', () => {
  const entries = parsePronunciations('مهر = مِهر\nAPI = اِی پی آی\na+b = تست\nکتاب = مهر');
  assert.equal(applyPronunciations('مهر مهربان مهرماه API a+b کتاب', entries), 'مِهر مهربان مهرماه اِی پی آی تست مهر');
  assert.throws(() => parsePronunciations('اشتباه'), /هر تلفظ/);
  assert.throws(() => parsePronunciations('مهر = مِهر\nمهر = مُهر'), /بیش از یک/);
});

test('Thirty-minute-scale input is chunked without omitted words or punctuation', () => {
  const source = Array.from({length: 350}, (_, index) => `این روایت شماره ${index} است؛ متن فارسی برای بررسی تولید صدای بلند. آیا همهٔ واژه‌ها باقی می‌مانند؟`).join('\n');
  const normalized = prepareText(source);
  const chunks = splitText(normalized);
  assert.ok(estimateSeconds(source) > 1800);
  assert.ok(chunks.length > 350);
  assert.ok(chunks.every(chunk => chunk.length <= 220 && chunk.trim()));
  assert.equal(chunks.join('').replace(/\s/g, ''), normalized.replace(/\s/g, ''));
  const token = 'نام'.repeat(1000) + '🙂'.repeat(100);
  assert.equal(splitText(token).join(''), token);
  assert.ok(splitText(token).every(chunk => chunk.length <= 220));
});

test('WAV exports have correct 30-minute RIFF length, sample rate and PCM bounds', async () => {
  const samples = 22050 * 1800;
  const header = new DataView(wavHeader(samples, 22050));
  assert.equal(header.getUint32(24, true), 22050);
  assert.equal(header.getUint32(40, true), 79380000);
  assert.equal(header.getUint32(4, true), 79380036);
  const data = pcm16(Float32Array.from([-2, -1, 0, 1, 2]));
  const view = new DataView(data);
  assert.deepEqual(Array.from({length: 5}, (_, index) => view.getInt16(index * 2, true)), [-32768, -32768, 0, 32767, 32767]);
  const wav = makeWav([new Blob([data])], 5, 22050);
  assert.equal(wav.size, 54);
  assert.equal(new TextDecoder().decode((await wav.arrayBuffer()).slice(0, 4)), 'RIFF');
  assert.throws(() => makeWav([data], 100, 22050), /کامل نیستند/);
});
