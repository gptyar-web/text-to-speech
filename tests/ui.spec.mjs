import {test, expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {readFile} from 'node:fs/promises';

async function mockEngine(page, {seconds = 2, delay = 30} = {}) {
  await page.route('**/src/worker.js', route => route.fulfill({contentType: 'text/javascript', body: `
    self.onmessage = async ({data}) => {
      await new Promise(resolve => setTimeout(resolve, ${delay}));
      if(data.type==='init') self.postMessage({id:data.id,type:'result',value:{sampleRate:22050}});
      else {
        const pcm = new Int16Array(22050 * ${seconds});
        for(let index=0;index<pcm.length;index++) pcm[index] = Math.sin(index/12)*12000;
        self.postMessage({id:data.id,type:'result',value:{sampleRate:22050,samples:pcm.length,pcm:pcm.buffer}},[pcm.buffer]);
      }
    };` }));
}

test('Persian RTL UI, self-hosted Vazirmatn, responsive layout and accessibility', async ({page}) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', {level: 1})).toContainText('آوا بخواند');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('#generate')).toBeDisabled();
  await page.locator('#sample').click();
  await expect(page.locator('#generate')).toBeEnabled();
  await expect(page.locator('#word-count')).not.toHaveText('۰');
  await expect(page.locator('#saved-status')).toContainText('ذخیره شد');
  await page.reload();
  await expect(page.locator('#text')).toHaveValue(/به استودیوی آوا/);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.locator('#text').evaluate(element => getComputedStyle(element).fontFamily)).toContain('Vazirmatn');
  await page.screenshot({path: 'test-results/ava-desktop.png', fullPage: true});
  const desktop = await new AxeBuilder({page}).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(desktop.violations).toEqual([]);
  for (const width of [390, 320, 768]) {
    await page.setViewportSize({width, height: 844});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  }
  await page.setViewportSize({width: 390, height: 844});
  await page.screenshot({path: 'test-results/ava-mobile.png', fullPage: true});
  const mobile = await new AxeBuilder({page}).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(mobile.violations).toEqual([]);
  expect(errors).toEqual([]);
});

test('Pause, refresh, resume and download preserve one continuous WAV', async ({page}) => {
  await mockEngine(page, {delay: 150});
  await page.goto('/');
  await page.locator('#text').fill('سلام دوست من. این یک روایت فارسی است. بخش سوم روایت اینجا است. اکنون پایان متن می‌رسد.');
  await expect(page.locator('#generate')).toBeEnabled();
  await page.locator('#generate').click();
  await expect(page.locator('#progress-heading')).toContainText('در حال ساخت');
  await page.locator('#pause-job').click();
  await expect(page.locator('#restore')).toBeVisible();
  await expect(page.locator('#output')).toBeVisible();
  await page.reload();
  await expect(page.locator('#restore')).toBeVisible();
  await expect(page.locator('#download')).toHaveAttribute('download', /بخش‌های-آماده/);
  await page.locator('#resume').click();
  await expect(page.locator('#progress-heading')).toContainText('آماده است');
  await expect(page.locator('#restore')).toBeHidden();
  const request = page.waitForEvent('download');
  await page.locator('#download').click();
  const file = await request;
  const wav = await readFile(await file.path());
  expect(wav.subarray(0, 4).toString()).toBe('RIFF');
  expect(wav.readUInt32LE(40)).toBe(4 * 2 * 22050 * 2);
  expect(wav.length).toBe(44 + wav.readUInt32LE(40));
  await expect(page.locator('#audio')).toHaveJSProperty('duration', 8);
});

test('Thirty-minute WAV assembly stays downloadable across reload', async ({page}) => {
  await mockEngine(page, {seconds: 60, delay: 5});
  await page.goto('/');
  await page.locator('#text').fill(Array.from({length: 31}, (_, index) => `این بخش ${index} از روایت طولانی است.`).join(' '));
  await expect(page.locator('#generate')).toBeEnabled();
  await page.locator('#generate').click();
  await expect(page.locator('#progress-heading')).toContainText('آماده است', {timeout: 60000});
  await expect(page.locator('#audio')).toHaveJSProperty('duration', 1860);
  await page.reload();
  await expect(page.locator('#audio')).toHaveJSProperty('duration', 1860);
  const wave = await page.locator('#download').evaluate(async element => {
    const blob = await (await fetch(element.href)).blob();
    const header = new DataView(await blob.slice(0, 44).arrayBuffer());
    return {size: blob.size, samples: header.getUint32(40, true) / 2, rate: header.getUint32(24, true)};
  });
  expect(wave.rate).toBe(22050);
  expect(wave.samples / wave.rate).toBe(1860);
  expect(wave.size).toBe(44 + 1860 * 22050 * 2);
});

test('Invalid pronunciation rules fail visibly without losing input; UTF-8 TXT imports work', async ({page}) => {
  await page.goto('/');
  await page.locator('#file').setInputFiles({name: 'داستان.txt', mimeType: 'text/plain', buffer: Buffer.from('سلام به دنیای صدا.')});
  await expect(page.locator('#text')).toHaveValue('سلام به دنیای صدا.');
  await expect(page.locator('#project-name')).toHaveValue('داستان');
  await page.locator('.pronunciation summary').click();
  await page.locator('#pronunciations').fill('این خط معتبر نیست');
  await page.locator('#generate').click();
  await expect(page.locator('#error')).toContainText('هر تلفظ');
  await expect(page.locator('#text')).toHaveValue('سلام به دنیای صدا.');
});
