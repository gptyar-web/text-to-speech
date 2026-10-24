import {MAX_CHARACTERS, SAMPLE_TEXT, prepareText, splitText, wordCount, estimateSeconds, formatTime} from './text.mjs';
import {makeWav} from './audio.mjs';
import {getState, setState, getParts, resetJob, commitPart} from './storage.mjs';

const $ = id => document.getElementById(id);
const fa = value => new Intl.NumberFormat('fa-IR').format(value);
const faTime = value => formatTime(value).replace(/\d/g, digit => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)]);
let worker;
let rpcCounter = 0;
const pending = new Map();
let busy = false;
let previewing = false;
let job;
let storageAvailable = true;
let pauseRequested = false;
let wakeLock;
let outputURL;
let previewURL;
let previewAudio;
let saveTimer;
let toastTimer;
let currentPhase = '';
let sessionStarted;
let sessionStartIndex;
let appReady = false;

for (const container of document.querySelectorAll('[data-wave]')) {
  const kind = container.dataset.wave;
  const count = kind === 'hero' ? 39 : kind === 'voice' ? 55 : 11;
  for (let index = 0; index < count; index++) {
    const bar = document.createElement('span');
    bar.className = 'wave-bar';
    const envelope = Math.sin((index + 1) / (count + 1) * Math.PI);
    const ripple = 0.22 + 0.78 * Math.abs(Math.sin(index * 1.67 + 0.3));
    bar.style.height = `${Math.round(4 + envelope * ripple * (kind === 'hero' ? 58 : kind === 'voice' ? 29 : 17))}px`;
    bar.style.setProperty('--i', index);
    container.append(bar);
  }
}

function settings() {
  return {speed: Number($('speed').value), pause: Number($('pause').value), numbers: $('numbers').checked, pronunciations: $('pronunciations').value};
}

function showError(error) {
  $('error').textContent = error?.name === 'QuotaExceededError'
    ? 'فضای ذخیره‌سازی این مرورگر پر شده است. آخرین بخش‌های سالم محفوظ‌اند؛ فضای دستگاه را آزاد کنید و ادامه دهید.'
    : (error?.message || String(error));
  $('error').hidden = false;
  $('error').focus({preventScroll: true});
}

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}

function statistics() {
  const text = $('text').value;
  $('word-count').textContent = fa(wordCount(text));
  $('char-count').textContent = fa(text.length);
  $('duration-estimate').textContent = faTime(estimateSeconds(text, Number($('speed').value)));
  const speed = Number($('speed').value);
  $('speed-value').textContent = `${speed.toFixed(2).replace(/0$/, '')}×`;
  $('speed').setAttribute('aria-valuetext', `سرعت ${fa(speed)} برابر`);
  $('generate').disabled = !appReady || busy || !text.trim() || !storageAvailable;
  $('preview').disabled = !appReady || busy || !text.trim();
}

async function saveDraft() {
  if (!storageAvailable || !appReady) return;
  $('saved-status').textContent = 'در حال ذخیره…';
  try {
    await setState('draft', {text: $('text').value, name: $('project-name').value, settings: settings()});
    $('saved-status').textContent = 'ذخیره شد در این مرورگر';
  } catch (error) {
    $('saved-status').textContent = 'پیش‌نویس ذخیره نشد';
    showError(error);
  }
}

function changed() {
  previewAudio?.pause();
  previewAudio = undefined;
  if (previewURL) { URL.revokeObjectURL(previewURL); previewURL = undefined; }
  $('preview-label').textContent = 'آزمایش ابتدای متن';
  statistics();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDraft, 450);
}

function setBusy(value) {
  busy = value;
  document.body.classList.toggle('is-working', value);
  for (const id of ['text', 'project-name', 'speed', 'pause', 'numbers', 'pronunciations', 'sample', 'import', 'clear', 'resume', 'discard']) $(id).disabled = value;
  $('generate').querySelector('span').textContent = value ? (previewing ? 'آزمایش صدا…' : 'در حال ساخت…') : 'ساخت فایل صوتی';
  $('pause-job').hidden = previewing;
  $('pause-job').disabled = false;
  $('pause-job').textContent = 'مکث پس از این بخش';
  statistics();
}

function progress(heading, detail, percentage = 0) {
  $('progress-panel').hidden = false;
  $('progress-heading').textContent = heading;
  $('progress-detail').textContent = detail;
  $('progress').value = Math.max(0, Math.min(100, percentage));
  $('progress-number').textContent = fa(Math.round(percentage)) + '٪';
}

function engineProgress(event) {
  currentPhase = event.phase;
  if (event.phase === 'download') {
    const percent = event.loaded / event.total * 100;
    progress('دریافت صدای فارسی', `${fa((event.loaded / 1048576).toFixed(1))} از ${fa((event.total / 1048576).toFixed(1))} مگابایت؛ این فایل برای استفادهٔ بعدی ذخیره می‌شود.`, percent);
  } else if (event.phase === 'runtime') {
    progress('آماده‌سازی موتور گفتار', 'در اولین اجرا، دریافت فایل‌های صوت‌ساز ممکن است چند دقیقه طول بکشد.');
  } else if (event.phase === 'cached') {
    progress('صدای فارسی در دستگاه شماست', 'در حال باز کردن مدل ذخیره‌شده…', 100);
  } else if (event.phase === 'compile') {
    progress('راه‌اندازی صدای امیر', 'مدل دریافت شد. موتور در حال آماده‌سازی برای تولید صوت است…', 100);
  }
}

function stopWorker(reason = new DOMException('تولید متوقف شد؛ بخش‌های کامل ذخیره شده‌اند.', 'AbortError')) {
  worker?.terminate();
  worker = undefined;
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(reason); }
  pending.clear();
}

function rpc(type, data = {}) {
  if (!worker) {
    worker = new Worker(new URL('./worker.js', import.meta.url));
    worker.onmessage = ({data: message}) => {
      if (message.type === 'progress') { engineProgress(message); return; }
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.type === 'error') request.reject(new Error(message.message));
      else request.resolve(message.value);
    };
    worker.onerror = event => {
      const error = new Error('موتور صدا اجرا نشد. از نسخهٔ جدید Chrome یا Edge استفاده کنید و دوباره تلاش کنید. ' + (event.message || ''));
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
      pending.clear();
      worker?.terminate();
      worker = undefined;
    };
  }
  const id = ++rpcCounter;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stopWorker(new Error('پاسخ موتور بیش از حد طول کشید. بخش‌های کامل ذخیره شده‌اند؛ دوباره ادامه دهید.'));
    }, type === 'init' ? 600000 : 180000);
    pending.set(id, {resolve, reject, timer});
    worker.postMessage({id, type, ...data});
  });
}

async function acquireWakeLock() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); } catch { /* Optional. */ }
}

async function exclusive(action) {
  if (navigator.locks) {
    return navigator.locks.request('ava-generation', {ifAvailable: true}, lock => {
      if (!lock) throw new Error('آوا در تب دیگری در حال تولید صوت است. ابتدا آن تولید را متوقف کنید.');
      return action();
    });
  }
  return action();
}

function showRestore() {
  const available = job && job.next < job.chunks.length;
  $('restore').hidden = !available;
  if (available) $('restore-info').textContent = `${fa(job.next)} از ${fa(job.chunks.length)} بخش ذخیره شده؛ ادامه با متن و تنظیمات زمان شروع انجام می‌شود.`;
}

function clearOutput() {
  $('audio').pause();
  $('audio').removeAttribute('src');
  $('audio').load();
  if (outputURL) URL.revokeObjectURL(outputURL);
  outputURL = undefined;
  $('download').removeAttribute('href');
  $('output').hidden = true;
  $('output-empty').hidden = false;
}

async function displayOutput(complete = true) {
  if (!job?.totalSamples) return;
  const parts = await getParts();
  if (parts.length !== job.next) throw new Error('ذخیرهٔ صوت کامل نیست. لطفاً پروژه را دوباره تولید کنید.');
  const wav = makeWav(parts, job.totalSamples, job.sampleRate);
  clearOutput();
  outputURL = URL.createObjectURL(wav);
  $('audio').src = outputURL;
  $('download').href = outputURL;
  const name = (job.name || 'روایت تازه').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim().slice(0, 70) || 'ava';
  $('download').download = name + (complete ? '' : '-بخش‌های-آماده') + '.wav';
  $('output-title').textContent = complete ? `${job.name || 'روایت شما'}، آمادهٔ شنیدن` : 'بخش‌های آمادهٔ روایت';
  $('output-meta').textContent = `${faTime(job.totalSamples / job.sampleRate)} دقیقه و ثانیه · ${fa((wav.size / 1048576).toFixed(1))} مگابایت · ${fa(job.next)} بخش`;
  $('output').hidden = false;
  $('output-empty').hidden = true;
}

async function run(resume = false) {
  if (busy) return;
  $('error').hidden = true;
  try {
    const source = $('text').value;
    const preferences = settings();
    if (!resume && (!source.trim() || source.length > MAX_CHARACTERS)) throw new Error('متن را وارد کنید؛ حداکثر طول متن ۱۲۰ هزار نویسه است.');
    let prepared;
    if (!resume) {
      prepared = splitText(prepareText(source, preferences));
      if (!prepared.length || !/[\p{L}\p{N}]/u.test(source)) throw new Error('متن باید دست‌کم یک واژه داشته باشد.');
      if (job && !window.confirm('با شروع پروژهٔ تازه، صوت ذخیره‌شدهٔ قبلی جایگزین می‌شود. در صورت نیاز، اول آن را دانلود کنید. ادامه می‌دهید؟')) return;
    }
    await exclusive(async () => {
      setBusy(true);
      pauseRequested = false;
      $('restore').hidden = true;
      await saveDraft();
      await acquireWakeLock();
      try { await navigator.storage?.persist?.(); } catch { /* Best effort. */ }
      progress('آماده‌سازی روایت', 'متن شما روی همین دستگاه پردازش می‌شود.');
      const {sampleRate} = await rpc('init');
      $('engine-caption').textContent = 'صدای فارسی آماده است؛ تولید روی همین دستگاه انجام می‌شود.';
      if (!resume) {
        const nextJob = {id: crypto.randomUUID(), name: $('project-name').value.trim() || 'روایت تازه', source, chunks: prepared, settings: preferences, next: 0, totalSamples: 0, sampleRate, status: 'running'};
        await resetJob(nextJob);
        job = nextJob;
        clearOutput();
      }
      if (!job || job.sampleRate !== sampleRate) throw new Error('تنظیمات صدای ذخیره‌شده سازگار نیست؛ پروژهٔ تازه بسازید.');
      sessionStarted = performance.now();
      sessionStartIndex = job.next;
      while (job.next < job.chunks.length) {
        const index = job.next;
        const completedHere = index - sessionStartIndex;
        const remaining = completedHere > 0 ? ((performance.now() - sessionStarted) / 1000 / completedHere * (job.chunks.length - index)) : null;
        progress('در حال ساخت روایت شما', `بخش ${fa(index + 1)} از ${fa(job.chunks.length)} · ${faTime(job.totalSamples / sampleRate)} صوت آماده${remaining ? ` · حدود ${faTime(remaining)} تا پایان` : ' · زمان تولید به توان دستگاه بستگی دارد'}`, index / job.chunks.length * 100);
        const audio = await rpc('generate', {text: job.chunks[index], speed: job.settings.speed, pause: job.settings.pause});
        if (audio.sampleRate !== job.sampleRate || audio.samples * 2 !== audio.pcm.byteLength) throw new Error('بخش صوتی معتبر نیست.');
        const nextJob = {...job, next: index + 1, totalSamples: job.totalSamples + audio.samples, status: 'running'};
        await commitPart(index, new Blob([audio.pcm], {type: 'application/octet-stream'}), nextJob);
        job = nextJob;
        if (pauseRequested) break;
      }
      const complete = job.next === job.chunks.length;
      job = {...job, status: complete ? 'complete' : 'paused'};
      await setState('job', job);
      await displayOutput(complete);
      progress(complete ? 'روایت شما آماده است.' : 'تولید با موفقیت مکث شد.', complete ? 'فایل یکپارچه را پخش یا دانلود کنید.' : 'بخش‌های کامل محفوظ‌اند. هر زمان خواستید، ادامه دهید.', job.next / job.chunks.length * 100);
      if (complete) toast('صدای شما آمادهٔ پخش و دانلود است.');
    });
  } catch (error) {
    if (error.name !== 'AbortError') showError(error);
    else toast('تولید متوقف شد. بخش‌های کامل محفوظ‌اند.');
    if (job && job.next < job.chunks.length) {
      job = {...job, status: 'paused'};
      try { await setState('job', job); await displayOutput(false); } catch { /* Preserve the previous atomic checkpoint. */ }
    }
    stopWorker();
  } finally {
    await wakeLock?.release().catch(() => {});
    wakeLock = undefined;
    setBusy(false);
    showRestore();
    document.querySelector('.progress-actions').hidden = true;
  }
}

async function preview() {
  if (busy) return;
  $('error').hidden = true;
  try {
    const preferences = settings();
    const chunks = splitText(prepareText($('text').value, preferences), 160);
    if (!chunks.length) throw new Error('ابتدا متن را وارد کنید.');
    await exclusive(async () => {
      previewing = true;
      setBusy(true);
      progress('آزمایش ابتدای متن', 'حداکثر ۱۶۰ نویسهٔ ابتدای متن خوانده می‌شود.');
      document.querySelector('.progress-actions').hidden = false;
      await rpc('init');
      progress('ساخت نمونهٔ کوتاه', 'در حال آماده‌سازی صدای ابتدای متن…');
      const audio = await rpc('generate', {text: chunks[0], speed: preferences.speed, pause: preferences.pause});
      const wav = makeWav([audio.pcm], audio.samples, audio.sampleRate);
      previewAudio?.pause();
      if (previewURL) URL.revokeObjectURL(previewURL);
      previewURL = URL.createObjectURL(wav);
      previewAudio = new Audio(previewURL);
      $('preview-label').textContent = 'پخش نمونهٔ ساخته‌شده';
      try { await previewAudio.play(); toast('نمونهٔ ابتدای متن در حال پخش است.'); }
      catch { toast('نمونه آماده است؛ برای پخش، دوباره روی آزمایش کلیک کنید.'); }
      $('progress-panel').hidden = true;
    });
  } catch (error) {
    if (error.name !== 'AbortError') showError(error);
    stopWorker();
    $('progress-panel').hidden = true;
  } finally {
    previewing = false;
    setBusy(false);
    document.querySelector('.progress-actions').hidden = true;
    showRestore();
  }
}

async function importFile(file) {
  if (!file || busy) return;
  try {
    if (!/\.txt$/i.test(file.name) || file.size > 2 * 1024 * 1024) throw new Error('یک فایل TXT با کدگذاری UTF-8 و اندازهٔ کمتر از ۲ مگابایت انتخاب کنید.');
    let text;
    try { text = new TextDecoder('utf-8', {fatal: true}).decode(await file.arrayBuffer()); }
    catch { throw new Error('کدگذاری فایل باید UTF-8 باشد. فایل را با این کدگذاری ذخیره و دوباره وارد کنید.'); }
    if (text.length > MAX_CHARACTERS) throw new Error('متن فایل بیشتر از ۱۲۰ هزار نویسه است. آن را به چند پروژه تقسیم کنید.');
    if ($('text').value.trim() && !window.confirm('متن فعلی با متن فایل جایگزین شود؟')) return;
    $('text').value = text;
    $('project-name').value = file.name.replace(/\.txt$/i, '').slice(0, 70);
    changed();
    toast('متن فایل وارد شد.');
  } catch (error) { showError(error); }
  $('file').value = '';
}

for (const id of ['text', 'project-name', 'speed', 'pause', 'numbers', 'pronunciations']) $(id).addEventListener('input', changed);
$('sample').addEventListener('click', () => {
  if ($('text').value.trim() && !window.confirm('متن فعلی با متن نمونه جایگزین شود؟')) return;
  $('text').value = SAMPLE_TEXT;
  changed();
  $('text').focus();
});
$('clear').addEventListener('click', () => {
  if (!$('text').value || !window.confirm('متن ویرایشگر پاک شود؟ فایل صوتی ذخیره‌شده حفظ می‌شود.')) return;
  $('text').value = '';
  changed();
});
$('import').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', event => importFile(event.target.files[0]));
$('text').addEventListener('dragover', event => { event.preventDefault(); if (!busy) $('text').classList.add('dragging'); });
$('text').addEventListener('dragleave', () => $('text').classList.remove('dragging'));
$('text').addEventListener('drop', event => { event.preventDefault(); $('text').classList.remove('dragging'); importFile(event.dataTransfer.files[0]); });
$('generate').addEventListener('click', () => { document.querySelector('.progress-actions').hidden = false; run(); });
$('resume').addEventListener('click', () => { document.querySelector('.progress-actions').hidden = false; run(true); });
$('preview').addEventListener('click', () => {
  if (previewAudio && previewURL) {
    if (previewAudio.paused) { previewAudio.currentTime = 0; previewAudio.play().catch(showError); }
    else previewAudio.pause();
  } else preview();
});
$('pause-job').addEventListener('click', () => {
  pauseRequested = true;
  $('pause-job').disabled = true;
  $('pause-job').textContent = 'در حال ذخیرهٔ این بخش…';
});
$('stop-job').addEventListener('click', () => { pauseRequested = true; stopWorker(); });
$('discard').addEventListener('click', async () => {
  if (busy || !window.confirm('پروژهٔ صوتی قبلی و بخش‌های آمادهٔ آن حذف شوند؟ متن ویرایشگر باقی می‌ماند.')) return;
  try {
    await exclusive(async () => { await resetJob(); job = undefined; clearOutput(); showRestore(); $('progress-panel').hidden = true; toast('پروژهٔ قبلی حذف شد.'); });
  } catch (error) { showError(error); }
});
document.addEventListener('visibilitychange', () => { if (busy && document.visibilityState === 'visible') acquireWakeLock(); });
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });

async function start() {
  try {
    const [draft, savedJob] = await Promise.all([getState('draft'), getState('job')]);
    if (draft) {
      $('text').value = draft.text || '';
      $('project-name').value = draft.name || 'روایت تازه';
      if (draft.settings) {
        $('speed').value = draft.settings.speed || 1;
        $('pause').value = draft.settings.pause || 0.4;
        $('numbers').checked = draft.settings.numbers !== false;
        $('pronunciations').value = draft.settings.pronunciations || '';
      }
    }
    job = savedJob;
    if (job?.totalSamples) await displayOutput(job.next === job.chunks.length);
    showRestore();
  } catch (error) {
    storageAvailable = false;
    $('storage-warning').textContent = 'ذخیره‌سازی مرورگر در دسترس نیست. برای ساخت و ادامهٔ فایل‌های طولانی، حالت خصوصی را ببندید یا اجازهٔ ذخیره‌سازی این سایت را فعال کنید. آزمایش کوتاه همچنان در دسترس است.';
    $('storage-warning').hidden = false;
    console.warn('Storage unavailable:', error);
  }
  appReady = true;
  statistics();
}
start();
