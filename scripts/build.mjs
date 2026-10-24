import {cp, mkdir, readFile, writeFile, rm, copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

const revision = '5041a7a49ae5b3a0f30e6837769eb03fdbb231bd';
const remote = `https://huggingface.co/rhasspy/piper-voices/resolve/${revision}/fa/fa_IR/amir/medium/`;
const files = [
  {name: 'fa_IR-amir-medium.onnx', sha: 'fb815380d969ea372b0b21b0de14421f58fe481047e153e69685d079b6e1a9d1'},
  {name: 'fa_IR-amir-medium.onnx.json', sha: '75f918a3bf0f57a9179abe725af529f2a5c79d6c899e2a84aec76c685d5dfb9a'},
];
const hash = data => createHash('sha256').update(data).digest('hex');
await mkdir('.cache/models', {recursive: true});
for (const file of files) {
  const cached = path.join('.cache/models', file.name);
  let data;
  try { data = await readFile(cached); } catch { /* First build. */ }
  if (!data || hash(data) !== file.sha) {
    console.log(`Downloading pinned Persian voice: ${file.name}`);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(remote + file.name + '?download=true', {signal: AbortSignal.timeout(300000)});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        data = Buffer.from(await response.arrayBuffer());
        if (hash(data) !== file.sha) throw new Error('SHA-256 mismatch');
        await writeFile(cached, data);
        break;
      } catch (error) {
        if (attempt === 2) throw new Error(`Cannot download ${file.name}: ${error.message}`);
      }
    }
  }
}
await rm('dist', {recursive: true, force: true});
await mkdir('dist', {recursive: true});
await cp('public', 'dist', {recursive: true});
await cp('src', 'dist/src', {recursive: true});
await copyFile('index.html', 'dist/index.html');
await cp('.cache/models', 'dist/models', {recursive: true});
await mkdir('dist/vendor/ort', {recursive: true});
for (const file of ['ort.wasm.min.js', 'ort-wasm-simd.wasm', 'ort-wasm.wasm']) {
  await copyFile('node_modules/onnxruntime-web/dist/' + file, 'dist/vendor/ort/' + file);
}
await cp('node_modules/@diffusionstudio/piper-wasm/build', 'dist/vendor/phonemize', {recursive: true});
await mkdir('dist/fonts', {recursive: true});
for (const subset of ['arabic', 'latin']) {
  const file = `vazirmatn-${subset}-wght-normal.woff2`;
  await copyFile('node_modules/@fontsource-variable/vazirmatn/files/' + file, 'dist/fonts/' + file);
}
await mkdir('dist/licenses', {recursive: true});
await copyFile('node_modules/@fontsource-variable/vazirmatn/LICENSE', 'dist/licenses/Vazirmatn-OFL.txt');
await copyFile('THIRD_PARTY_NOTICES.md', 'dist/licenses/THIRD_PARTY_NOTICES.md');
await copyFile('LICENSE', 'dist/licenses/GPL-3.0.txt');
await writeFile('dist/.nojekyll', '');
console.log('Built dist/: same-origin model, WASM runtime, fonts, and application.');
