import {test, expect} from '@playwright/test';
import {writeFile} from 'node:fs/promises';

test('Real Persian model produces non-silent, playable speech with no external text requests', async ({page}) => {
  test.skip(!process.env.VOICE_TEST && !process.env.LONG_TEST, 'Opt in to downloading/loading the actual Persian voice.');
  test.setTimeout(process.env.LONG_TEST ? 3600000 : 240000);
  const errors = [];
  const external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:4173') && !request.url().startsWith('blob:')) external.push(request.url()); });
  await page.goto('/');
  const text = process.env.LONG_TEST
    ? Array.from({length: 105}, () => 'سلام. به استودیوی آوا خوش آمدید. امروز می‌خواهیم دربارهٔ زیبایی زبان فارسی صحبت کنیم. هر کلمه می‌تواند آغاز یک داستان تازه باشد. زندگی پر از فرصت‌های تازه برای یاد گرفتن و شنیدن است.').join(' ')
    : 'سلام. به استودیوی آوا خوش آمدید. سال ۱۴۰۵ آغاز یک داستان تازه است. امروز یک روز زیبا برای شنیدن صدای فارسی است.';
  await page.locator('#text').fill(text);
  await expect(page.locator('#generate')).toBeEnabled();
  await page.locator('#generate').click();
  await expect(page.locator('#output')).toBeVisible({timeout: process.env.LONG_TEST ? 3500000 : 220000});
  await expect(page.locator('#error')).toBeHidden();
  await expect(page.locator('#progress-heading')).toContainText('آماده است');
  const result = await page.locator('#download').evaluate(async element => {
    const buffer = await (await fetch(element.href)).arrayBuffer();
    const view = new DataView(buffer);
    let max = 0;
    let energy = 0;
    for (let index = 44; index < buffer.byteLength; index += 2) {
      const sample = view.getInt16(index, true) / 32768;
      max = Math.max(max, Math.abs(sample));
      energy += sample * sample;
    }
    const samples = view.getUint32(40, true) / 2;
    const sampleRate = view.getUint32(24, true);
    return {duration: samples / sampleRate, sampleRate, bytes: buffer.byteLength, max, rms: Math.sqrt(energy / samples)};
  });
  expect(result.sampleRate).toBe(22050);
  expect(result.max).toBeGreaterThan(0.03);
  expect(result.rms).toBeGreaterThan(0.005);
  expect(result.duration).toBeGreaterThan(process.env.LONG_TEST ? 1800 : 5);
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
  await writeFile('test-results/real-voice-metrics.json', JSON.stringify(result, null, 2));
  await page.screenshot({path: 'test-results/ava-real-output.png', fullPage: true});
  console.log('Real voice metrics:', result);
});
