import {test, expect} from '@playwright/test';

test('A stale paused tab cannot overwrite a newer project', async ({page, context}) => {
  await context.route('**/src/worker.js', route => route.fulfill({contentType: 'text/javascript', body: `
    self.onmessage = async ({data}) => {
      await new Promise(resolve=>setTimeout(resolve,120));
      if(data.type==='init') self.postMessage({id:data.id,type:'result',value:{sampleRate:22050}});
      else {
        const pcm=new Int16Array(22050);
        self.postMessage({id:data.id,type:'result',value:{sampleRate:22050,samples:pcm.length,pcm:pcm.buffer}},[pcm.buffer]);
      }
    };` }));
  await page.goto('/');
  await page.locator('#text').fill('بخش اول روایت. بخش دوم روایت. بخش سوم روایت.');
  await expect(page.locator('#generate')).toBeEnabled();
  await page.locator('#generate').click();
  await expect(page.locator('#progress-heading')).toContainText('در حال ساخت');
  await page.locator('#pause-job').click();
  await expect(page.locator('#restore')).toBeVisible();
  const other = await context.newPage();
  other.on('dialog', dialog => dialog.accept());
  await other.goto('/');
  await expect(other.locator('#restore')).toBeVisible();
  await other.locator('#text').fill('این یک پروژه تازه است. اکنون پایان پروژه تازه است.');
  await other.locator('#generate').click();
  await expect(other.locator('#progress-heading')).toContainText('آماده است');
  await page.locator('#resume').click();
  await expect(page.locator('#error')).toContainText('تب دیگری تغییر کرده');
  await other.reload();
  await expect(other.locator('#audio')).toHaveJSProperty('duration', 2);
});
