const assert = require('node:assert/strict');
const { join } = require('node:path');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const playwright = require('playwright');

const app = pathToFileURL(join(__dirname, '../index.html')).href;
const engines = (process.env.BROWSERS || 'chromium,firefox,webkit').split(',');
const ready = (page, spec) => page.waitForFunction((expected) => !document.querySelector('#btnDownloadExport').disabled &&
  document.querySelector('#exportSpecSummary').textContent.includes(expected), spec, { timeout: 8000 });
const click = (page, sel) => page.locator(sel).click();
const type = async (page, sel, value) => {
  const locator = page.locator(sel);
  await locator.fill(String(value));
  await locator.press('Tab');
};
const on = (page, tab) => click(page, `[data-tab="${tab}"]`);
const format = (page, fmt) => click(page, `[data-format="image/${fmt}"]`);

async function open(engine, task, options = {}, setup) {
  const browser = await playwright[engine].launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, ...options });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    if (setup) await page.addInitScript(setup);
    await page.goto(app);
    await task(page);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

async function imageFixture(page, name, width, height, colors) {
  const data = await page.evaluate(({ width, height, colors }) => {
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    const ctx = c.getContext('2d');
    colors.forEach((color, i) => {
      if (!color) return;
      ctx.fillStyle = color;
      ctx.fillRect(i % width, Math.floor(i / width), 1, 1);
    });
    return c.toDataURL('image/png').split(',')[1];
  }, { width, height, colors });
  return { name, mimeType: 'image/png', buffer: Buffer.from(data, 'base64') };
}

async function download(page) {
  const [dl] = await Promise.all([page.waitForEvent('download'), click(page, '#btnDownloadExport')]);
  const parts = [];
  for await (const part of await dl.createReadStream()) parts.push(part);
  return { name: dl.suggestedFilename(), bytes: Buffer.concat(parts) };
}

async function readPixels(page, bytes, fmt) {
  return page.evaluate(async ({ base64, fmt }) => {
    const image = new Image();
    image.src = `data:image/${fmt};base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    return { width: canvas.width, height: canvas.height, bytes: [...ctx.getImageData(0, 0, canvas.width, canvas.height).data] };
  }, { base64: bytes.toString('base64'), fmt });
}

for (const engine of engines) {
  test(`${engine}: pixel crop, resize, rotations, BMP matte, and comparison`, { timeout: 45000 }, () => open(engine, async (page) => {
    const fixture = await imageFixture(page, 'edges.png', 3, 2, ['red', '#00ff00', 'red', 'blue', null, 'white']);
    await page.locator('#fileInput').setInputFiles(fixture);
    await ready(page, '3×2 · PNG (无损)');
    await type(page, '#inpCropX', 1);
    await type(page, '#inpCropW', 1);
    await type(page, '#inpCropH', 1);
    await on(page, 'resize');
    await click(page, '#btnLockAspect');
    await type(page, '#inpResizeW', 8);
    await ready(page, '8×1 · PNG (无损)');
    const output = await download(page);
    assert.equal(output.name, 'edges_edited.png');
    assert.deepEqual(await readPixels(page, output.bytes, 'png'), {
      width: 8, height: 1, bytes: Array.from({ length: 8 }, () => [0, 255, 0, 255]).flat()
    });

    await click(page, '#btnToggleCompareTop');
    await page.waitForFunction(() => document.querySelector('#compareAfterCanvas').width > 0);
    await page.locator('#compareDivider').press('Home');
    assert.equal(await page.locator('#compareDivider').getAttribute('aria-valuenow'), '2');
    await click(page, '#btnToggleCompareTop');
    await click(page, '#btnRotateRight');
    await ready(page, '1×8 · PNG');
    assert.equal(await page.locator('#inpCropX').inputValue(), '1');
    assert.equal(await page.locator('#inpCropY').inputValue(), '1');
    await click(page, '#btnFlipH');
    await ready(page, '1×8 · PNG');
    assert.equal(await page.locator('#inpCropX').inputValue(), '0');
    const turned = await readPixels(page, (await download(page)).bytes, 'png');
    assert.deepEqual(turned.bytes, Array.from({ length: 8 }, () => [0, 255, 0, 255]).flat());

    await click(page, '#btnResetAll');
    await ready(page, '3×2 · PNG');
    await on(page, 'export');
    await format(page, 'bmp');
    await click(page, '[data-matte="#000000"]');
    await ready(page, '3×2 · BMP (未压缩)');
    const bmp = (await download(page)).bytes;
    assert.equal(bmp.toString('ascii', 0, 2), 'BM');
    assert.deepEqual([...bmp.subarray(57, 60)], [0, 0, 0]); // Transparent pixel is on bottom row, centre.
  }));

  test(`${engine}: EXIF edit and strip, quality modes, and actual export bytes`, { timeout: 45000 }, () => open(engine, async (page) => {
    await click(page, '#btnLoadDemo');
    await ready(page, '1600×1066 · JPEG');
    await on(page, 'exif');
    assert.equal(await page.locator('#exifMake').inputValue(), 'SONY');
    await type(page, '#exifArtist', 'Test private name');
    await ready(page, 'JPEG');
    assert.ok((await download(page)).bytes.includes(Buffer.from('Test private name')));
    await click(page, 'label:has(#chkStripExif)');
    assert.equal(await page.locator('#chkStripExif').isChecked(), true);
    await ready(page, 'JPEG');
    assert.ok(!(await download(page)).bytes.includes(Buffer.from('Exif\0\0')));
    await on(page, 'export');
    await format(page, 'png');
    await ready(page, 'PNG (无损)');
    await format(page, 'jpeg');
    await click(page, '[data-mode="lossless"]');
    await ready(page, 'JPEG (最高画质（非无损）)');
    if (await page.locator('#btnFormatWebp').isVisible()) {
      await format(page, 'webp');
      await ready(page, 'WebP');
      let bytes;
      if (engine === 'firefox') {
        // Headless Firefox on some systems opens a native file handler for WebP without a download
        // event, even for a standalone anchor. Check the actual anchor payload before that handoff.
        await page.evaluate(() => {
          const click = HTMLAnchorElement.prototype.click;
          HTMLAnchorElement.prototype.click = function () {
            if (!this.download.endsWith('.webp')) return click.call(this);
            window.webpSave = fetch(this.href).then(async (r) => ({
              name: this.download, bytes: [...new Uint8Array(await r.arrayBuffer())]
            }));
          };
        });
        await click(page, '#btnDownloadExport');
        const saved = await page.evaluate(() => window.webpSave);
        assert.match(saved.name, /\.webp$/);
        bytes = Buffer.from(saved.bytes);
      } else {
        ({ bytes } = await download(page));
      }
      assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
      const chunks = [];
      for (let off = 12; off + 8 <= bytes.length;) {
        chunks.push(bytes.toString('ascii', off, off + 4));
        const length = bytes.readUInt32LE(off + 4);
        off += 8 + length + (length & 1);
      }
      assert.equal(chunks.includes('EXIF'), false);
    }
  }));
}

if (engines.includes('chromium')) {
  test('chromium: stale compare image and superseded encodes cannot publish', { timeout: 45000 }, () => open('chromium', async (page) => {
    await page.locator('#fileInput').setInputFiles(await imageFixture(page, 'race.png', 3, 1, ['red', 'green', 'blue']));
    await ready(page, '3×1 · PNG');
    await page.evaluate(() => {
      const { Image: NativeImage } = window;
      const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      window.Image = function () {
        const img = new NativeImage();
        Object.defineProperty(img, 'src', { set(value) {
          window.releaseOldPreview = () => new Promise((resolve) => {
            img.addEventListener('load', resolve, { once: true });
            src.set.call(img, value);
            window.Image = NativeImage;
          });
        } });
        return img;
      };
      const toBlob = HTMLCanvasElement.prototype.toBlob;
      window.pendingEncodes = [];
      HTMLCanvasElement.prototype.toBlob = function (cb, mime, quality) {
        if (this.width < 7) return toBlob.call(this, cb, mime, quality);
        const { width } = this;
        toBlob.call(this, (blob) => window.pendingEncodes.push({ width, release: () => cb(blob) }), mime, quality);
      };
    });
    await click(page, '#btnToggleCompareTop');
    await on(page, 'resize');
    await click(page, '#btnLockAspect');
    await type(page, '#inpResizeW', 7);
    await page.waitForFunction(() => window.pendingEncodes.length === 1);
    await page.evaluate(() => window.releaseOldPreview());
    assert.equal(await page.locator('#compareAfterCanvas').evaluate((c) => c.width), 0);
    await type(page, '#inpResizeW', 8);
    await type(page, '#inpResizeW', 9);
    await page.waitForFunction(() => document.querySelector('#btnDownloadExport').disabled);
    // Let the debounce fire while the prior canvas is deliberately still in flight.
    await page.waitForTimeout(260);
    assert.deepEqual(await page.evaluate(() => window.pendingEncodes.map((e) => e.width)), [7]);
    await page.evaluate(() => window.pendingEncodes[0].release());
    await page.waitForFunction(() => window.pendingEncodes.length === 2);
    assert.deepEqual(await page.evaluate(() => window.pendingEncodes.map((e) => e.width)), [7, 9]);
    assert.equal(await page.locator('#btnDownloadExport').isDisabled(), true);
    await page.evaluate(() => window.pendingEncodes[1].release());
    await ready(page, '9×1 · PNG');
  }));

  test('chromium: privacy failures cannot export the cached unverified bytes', { timeout: 30000 }, () => open('chromium', async (page) => {
    await page.locator('#fileInput').setInputFiles(await imageFixture(page, 'private.png', 2, 1, ['red', 'blue']));
    await ready(page, 'PNG');
    await page.evaluate(() => {
      const arrayBuffer = Blob.prototype.arrayBuffer;
      Blob.prototype.arrayBuffer = function () {
        if (window.failMetadata && this.type === 'image/png') return Promise.reject(new Error('fixture read failure'));
        return arrayBuffer.call(this);
      };
      window.failMetadata = true;
    });
    await on(page, 'exif');
    await click(page, 'label:has(#chkStripExif)');
    assert.equal(await page.locator('#chkStripExif').isChecked(), true);
    await page.waitForFunction(() => document.querySelector('#m3Snackbar').textContent.includes('无法确认 EXIF 已清除'));
    assert.equal(await page.locator('#btnDownloadExport').isDisabled(), true);
    await page.evaluate(() => { window.failMetadata = false; });
    await click(page, 'label:has(#chkStripExif)');
    assert.equal(await page.locator('#chkStripExif').isChecked(), false);
    await ready(page, 'PNG');
  }));

  test('chromium: latest input wins and dragging a tiny crop keeps its edge', { timeout: 30000 }, () => open('chromium', async (page) => {
    const original = await imageFixture(page, 'first.png', 40, 20, Array(800).fill('red'));
    const slow = await imageFixture(page, 'slow.png', 5, 3, Array(15).fill('blue'));
    await page.locator('#fileInput').setInputFiles(original);
    await ready(page, '40×20 · PNG');
    await type(page, '#inpCropW', 4);
    const box = await page.locator('#cropBox').boundingBox();
    const stage = await page.locator('#canvasStageInner').boundingBox();
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 2 - 2 * stage.width / 40, box.y + box.height / 2);
    await page.mouse.up();
    await ready(page, '2×20 · PNG');
    assert.equal(await page.locator('#inpCropX').inputValue(), '0');

    await page.evaluate(() => {
      const load = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = function () {
        if (this.name !== 'slow.png') return load.call(this);
        return new Promise((resolve) => { window.finishOldRead = () => resolve(load.call(this)); });
      };
    });
    await page.locator('#fileInput').setInputFiles(slow);
    await page.waitForFunction(() => typeof window.finishOldRead === 'function');
    await page.locator('#fileInput').setInputFiles({ name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') });
    await page.evaluate(() => window.finishOldRead());
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#fileNameLabel').textContent(), original.name);
    await ready(page, '2×20 · PNG');
  }));

  test('chromium: abnormal theme storage and short mobile viewport', { timeout: 30000 }, () => open('chromium', async (page) => {
    const trigger = page.locator('#btnSeedMobile');
    await trigger.press('Enter');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(await trigger.evaluate((el) => document.activeElement === el), true);
    assert.equal(await page.locator('.inspector-scroll').evaluate((el) => el.clientHeight > 0), true);
    await click(page, '#btnLoadDemo');
    await ready(page, 'JPEG');
    const save = await page.locator('#btnDownloadExport').boundingBox();
    const nav = await page.locator('.nav-rail').boundingBox();
    assert.ok(save.y + save.height <= nav.y);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.getByRole('button', { name: '修改尺寸', exact: true }).click();
    assert.equal(await page.locator('#panel-resize').isVisible(), true);
  }, { viewport: { width: 320, height: 390 }, isMobile: true, hasTouch: true }, () => {
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      return key === 'pixelstudio.prefs' ? 'null' : get.call(this, key);
    };
  }));
}
