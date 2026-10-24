/* Classic worker: all inference stays off the UI thread. No speechSynthesis dependency. */
let enginePromise;
let phonemizer;
let phonemeOutput = [];
let configuration;
let session;
const root = new URL('../', self.location.href);
const asset = path => new URL(path, root).href;
const MODEL_BYTES = 63531379;

async function loadModel() {
  const url = asset('models/fa_IR-amir-medium.onnx');
  let cache;
  try {
    cache = await caches.open('ava-model-fb815380-v1');
    const cached = await cache.match(url);
    if (cached) {
      const data = await cached.arrayBuffer();
      if (data.byteLength === MODEL_BYTES) {
        self.postMessage({type: 'progress', phase: 'cached'});
        return data;
      }
      await cache.delete(url);
    }
  } catch { /* Private browsing or quota restrictions: use an uncached download. */ }
  self.postMessage({type: 'progress', phase: 'download', loaded: 0, total: MODEL_BYTES});
  const response = await fetch(url, {signal: AbortSignal.timeout(300000)});
  if (!response.ok) throw new Error('دریافت مدل صدا انجام نشد. اتصال اینترنت را بررسی و دوباره تلاش کنید.');
  const reader = response.body.getReader();
  const pieces = [];
  let loaded = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    pieces.push(value);
    loaded += value.byteLength;
    self.postMessage({type: 'progress', phase: 'download', loaded, total: MODEL_BYTES});
  }
  if (loaded !== MODEL_BYTES) throw new Error('مدل صدا ناقص دریافت شد. دوباره تلاش کنید.');
  const blob = new Blob(pieces);
  try { await cache?.put(url, new Response(blob)); } catch { /* Cache is optional. */ }
  return blob.arrayBuffer();
}

function initialize() {
  return enginePromise ??= (async () => {
    self.postMessage({type: 'progress', phase: 'runtime'});
    importScripts(asset('vendor/ort/ort.wasm.min.js'), asset('vendor/phonemize/piper_phonemize.js'));
    ort.env.wasm.wasmPaths = asset('vendor/ort/');
    // GitHub Pages cannot set COOP/COEP headers; a single WASM thread works there.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    const response = await fetch(asset('models/fa_IR-amir-medium.onnx.json'));
    if (!response.ok) throw new Error('فایل تنظیمات صدا در دسترس نیست.');
    configuration = await response.json();
    if (configuration.espeak?.voice !== 'fa') throw new Error('مدل انتخاب‌شده فارسی نیست.');
    phonemizer = await createPiperPhonemize({
      noInitialRun: true,
      locateFile: name => asset('vendor/phonemize/' + name),
      print: line => { try { phonemeOutput.push(JSON.parse(line)); } catch { /* Ignore non-JSON logs. */ } },
      printErr: message => console.warn('[phonemizer]', message),
    });
    const model = await loadModel();
    self.postMessage({type: 'progress', phase: 'compile'});
    session = await ort.InferenceSession.create(model, {executionProviders: ['wasm'], graphOptimizationLevel: 'all'});
    return {sampleRate: configuration.audio.sample_rate};
  })();
}

async function generate(text, speed, pause) {
  await initialize();
  if (!text.trim() || text.length > 240) throw new Error('طول بخش صوتی معتبر نیست.');
  phonemeOutput = [];
  const result = phonemizer.callMain(['--espeak_data', '/espeak-ng-data', '--language', 'fa', '--input', JSON.stringify([{text}])]);
  if (result !== 0 || !phonemeOutput[0]?.phoneme_ids?.length) throw new Error('خواندن این بخش انجام نشد؛ نشانه‌گذاری یا تلفظ متن را بررسی کنید.');
  const eos = configuration.phoneme_id_map['$'][0];
  const sentences = [];
  let current = [];
  for (const id of phonemeOutput[0].phoneme_ids) {
    current.push(id);
    if (id === eos) { sentences.push(current); current = []; }
  }
  if (current.length) sentences.push(current);
  const sampleRate = configuration.audio.sample_rate;
  const parts = [];
  for (const ids of sentences) {
    const inference = configuration.inference;
    const feeds = {
      input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
      input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new ort.Tensor('float32', Float32Array.from([inference.noise_scale, inference.length_scale / speed, inference.noise_w]), [3]),
    };
    let outputs;
    try {
      outputs = await session.run(feeds);
      const samples = outputs[session.outputNames[0]].data;
      const pcm = new ArrayBuffer(samples.length * 2);
      const view = new DataView(pcm);
      for (let index = 0; index < samples.length; index++) {
        const sample = Math.max(-1, Math.min(1, samples[index]));
        view.setInt16(index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
      }
      parts.push(pcm);
      // Brief spacing at a length split, and the chosen pause at sentence endings.
      const gap = /[.!?;]$/.test(text) ? pause : 0.06;
      parts.push(new ArrayBuffer(Math.round(sampleRate * gap) * 2));
    } finally {
      Object.values(feeds).forEach(tensor => tensor.dispose?.());
      if (outputs) Object.values(outputs).forEach(tensor => tensor.dispose?.());
    }
  }
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const pcm = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { pcm.set(new Uint8Array(part), offset); offset += part.byteLength; }
  return {pcm: pcm.buffer, samples: length / 2, sampleRate};
}

let busy = false;
self.onmessage = async ({data}) => {
  if (busy) { self.postMessage({id: data.id, type: 'error', message: 'موتور در حال پردازش است.'}); return; }
  busy = true;
  try {
    if (data.type === 'init') self.postMessage({id: data.id, type: 'result', value: await initialize()});
    else if (data.type === 'generate') {
      const value = await generate(data.text, data.speed, data.pause);
      self.postMessage({id: data.id, type: 'result', value}, [value.pcm]);
    } else throw new Error('درخواست نامعتبر است.');
  } catch (error) {
    self.postMessage({id: data.id, type: 'error', message: error.message || 'تولید صوت انجام نشد.'});
  } finally { busy = false; }
};
