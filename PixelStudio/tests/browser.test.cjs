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

function withJpegOrientation(jpeg, orientation) {
  const tiff = Buffer.from('49492a0008000000010012010300010000000100000000000000', 'hex');
  tiff.writeUInt16LE(orientation, 18);
  const app1 = Buffer.from('ffe10022457869660000', 'hex');
  const split = jpeg.readUInt16BE(2) === 0xffe0 ? 4 + jpeg.readUInt16BE(4) : 2;
  return Buffer.concat([jpeg.subarray(0, split), app1, tiff, jpeg.subarray(split)]);
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

  test(`${engine}: EXIF orientation is applied once before pixel transforms`, { timeout: 45000 }, () => open(engine, async (page) => {
    const encoded = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 3; canvas.height = 2;
      const ctx = canvas.getContext('2d');
      ['red', 'lime', 'blue', 'yellow', 'magenta', 'cyan'].forEach((color, i) => {
        ctx.fillStyle = color;
        ctx.fillRect(i % 3, Math.floor(i / 3), 1, 1);
      });
      return canvas.toDataURL('image/jpeg', 0.98).split(',')[1];
    });
    const jpeg = withJpegOrientation(Buffer.from(encoded, 'base64'), 6);
    const source = await readPixels(page, jpeg, 'jpeg');
    assert.deepEqual([source.width, source.height], [2, 3]);
    await page.locator('#fileInput').setInputFiles({ name: 'oriented.jpg', mimeType: 'image/jpeg', buffer: jpeg });
    await ready(page, '2×3 · JPEG');
    await on(page, 'export');
    await format(page, 'png');
    await ready(page, '2×3 · PNG (无损)');
    assert.deepEqual(await readPixels(page, (await download(page)).bytes, 'png'), source);
    await click(page, '#btnRotateRight');
    await ready(page, '3×2 · PNG (无损)');
    const expected = [];
    for (let x = 0; x < source.width; x++) {
      for (let y = source.height - 1; y >= 0; y--) {
        const i = (y * source.width + x) * 4;
        expected.push(...source.bytes.slice(i, i + 4));
      }
    }
    assert.deepEqual(await readPixels(page, (await download(page)).bytes, 'png'), { width: 3, height: 2, bytes: expected });
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

  test(`${engine}: EXIF fixed-point fields round decimal halves`, { timeout: 30000 }, () => open(engine, async (page) => {
    const fixture = await imageFixture(page, 'rounding.png', 1, 1, ['red']);
    await page.locator('#fileInput').setInputFiles(fixture);
    await ready(page, 'PNG (无损)');
    await on(page, 'exif');
    await type(page, '#exifFNumber', '1.005');
    assert.equal(await page.locator('#exifFNumber').inputValue(), '1.01');
    await type(page, '#exifFocal', '0.145');
    assert.equal(await page.locator('#exifFocal').inputValue(), '0.15');
    await ready(page, 'PNG (无损)');
  }));

  test(`${engine}: EXIF text limits block stale downloads and allow recovery`, { timeout: 45000 }, () => open(engine, async (page) => {
    const fixture = await imageFixture(page, 'metadata.png', 1, 1, ['red']);
    await page.locator('#fileInput').setInputFiles(fixture);
    await ready(page, 'PNG (无损)');
    await on(page, 'exif');
    const longText = '像'.repeat(10922); // 32766 bytes
    const tooLong = '像'.repeat(10923);
    await page.locator('#exifMake').fill(tooLong);
    await page.waitForFunction(() => document.querySelector('#exportSpecSummary').textContent.includes('32767'));
    assert.equal(await page.locator('#btnDownloadExport').isDisabled(), true);
    assert.equal(await page.locator('#exifMake').inputValue(), tooLong);

    await page.locator('#exifMake').fill(longText);
    await ready(page, 'PNG (无损)');
    assert.ok((await download(page)).bytes.includes(Buffer.from(longText)));
    await page.locator('#exifArtist').fill('A'.repeat(32767));
    await ready(page, 'PNG (无损)');
    await on(page, 'export');
    await format(page, 'jpeg');
    await page.waitForFunction(() => document.querySelector('#exportSpecSummary').textContent.includes('64KB'));
    assert.equal(await page.locator('#btnDownloadExport').isDisabled(), true);
    await format(page, 'png');
    await ready(page, 'PNG (无损)');
    await on(page, 'exif');
    await click(page, 'label:has(#chkStripExif)');
    await ready(page, 'PNG (无损)');
    assert.ok(!(await download(page)).bytes.includes(Buffer.from(longText)));
  }));
}

if (engines.includes('chromium')) {
  test('chromium: keyboard focus moves from the picker to the new crop box', { timeout: 30000 }, () => open('chromium', async (page) => {
    await page.locator('#btnLoadDemo').press('Enter');
    await ready(page, '1600×1066 · JPEG');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'cropBox');
    await page.keyboard.press('Shift+ArrowLeft');
    await ready(page, '1599×1066 · JPEG');
    assert.equal(await page.locator('#inpCropW').inputValue(), '1599');
  }));

  test('chromium: geometry and metadata editing are enabled only once an image is loaded', { timeout: 30000 }, () => open('chromium', async (page) => {
    assert.equal(await page.locator('#inpCropW').isDisabled(), true);
    assert.equal(await page.locator('#inpCropW').inputValue(), '');
    await on(page, 'resize');
    assert.equal(await page.locator('#sliderScalePercent').isDisabled(), true);
    await on(page, 'exif');
    assert.equal(await page.locator('#exifArtist').isDisabled(), true);
    assert.equal(await page.locator('#chkStripExif').isDisabled(), false);
    await click(page, '#btnLoadDemo');
    await ready(page, 'JPEG');
    assert.equal(await page.locator('#exifArtist').isDisabled(), false);
    assert.equal(await page.locator('#inpCropW').inputValue(), '1600');
    assert.equal(await page.locator('#sliderScalePercent').isDisabled(), false);
    await type(page, '#exifIso', 0);
    await page.waitForFunction(() => document.querySelector('#m3Snackbar').textContent.includes('ISO 感光度无效'));
    assert.equal(await page.locator('#exifIso').inputValue(), '');
    await type(page, '#exifFNumber', -1.8);
    await page.waitForFunction(() => document.querySelector('#m3Snackbar').textContent.includes('光圈值无效'));
    assert.equal(await page.locator('#exifFNumber').inputValue(), '');
    await type(page, '#exifIso', 4294967296);
    await page.waitForFunction(() => document.querySelector('#m3Snackbar').textContent.includes('已调整为 4294967295'));
    assert.equal(await page.locator('#exifIso').inputValue(), '4294967295');
    await type(page, '#exifFNumber', 42949672.96);
    await page.waitForFunction(() => document.querySelector('#m3Snackbar').textContent.includes('0.01 到 42949672.95'));
    assert.equal(await page.locator('#exifFNumber').inputValue(), '');
  }));

  test('chromium: a capped resize keeps the requested slider value', { timeout: 30000 }, () => open('chromium', async (page) => {
    await page.locator('#fileInput').setInputFiles(await imageFixture(page, 'panorama.png', 11000, 1, ['red']));
    await ready(page, '11000×1 · PNG');
    await on(page, 'resize');
    const slider = page.locator('#sliderScalePercent');
    await slider.press('End');
    await ready(page, '16383×1 · PNG');
    assert.equal(await slider.inputValue(), '200');
    assert.match(await page.locator('#scaleLimitNote').textContent(), /200%.*149%/);
    await slider.press('ArrowLeft');
    assert.equal(await slider.inputValue(), '199');
    await on(page, 'crop');
    await type(page, '#inpCropW', 8000);
    await ready(page, '15920×2 · PNG');
    assert.equal(await page.locator('#scaleLimitNote').isHidden(), true);
    await type(page, '#inpCropW', 1);
    await on(page, 'resize');
    await click(page, '[data-scale="0.5"]');
    assert.equal(await slider.inputValue(), '50');
    assert.equal(await page.locator('#resizePresetChips .active').count(), 1);
    await click(page, '#btnLockAspect');
    await type(page, '#inpResizeW', 20000);
    await page.waitForFunction(() => document.querySelector('#m3Snackbar').textContent.includes('宽度超出浏览器画布上限，已调整为 16383 px'));
    assert.equal(await page.locator('#inpResizeW').inputValue(), '16383');
    await ready(page, '16383×1 · PNG');
  }));

  test('chromium: detected file format and unknown input preserve transparency', { timeout: 30000 }, () => open('chromium', async (page) => {
    const png = await imageFixture(page, 'mislabeled.jpg', 2, 1, ['red', null]);
    await page.locator('#fileInput').setInputFiles({ ...png, mimeType: 'image/jpeg' });
    await ready(page, '2×1 · PNG (无损)');
    assert.deepEqual((await readPixels(page, (await download(page)).bytes, 'png')).bytes, [255, 0, 0, 255, 0, 0, 0, 0]);
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    await page.locator('#fileInput').setInputFiles({ name: 'unknown-image', mimeType: 'image/gif', buffer: gif });
    await ready(page, '1×1 · PNG (无损)');
    assert.equal((await readPixels(page, (await download(page)).bytes, 'png')).bytes[3], 0);
    await on(page, 'export');
    await format(page, 'jpeg');
    await ready(page, 'JPEG');
    await page.locator('#fileInput').setInputFiles(png);
    await ready(page, '2×1 · JPEG');
  }));

  test('chromium: PNG defaults to lossless and BMP does not change a manual preference', { timeout: 30000 }, () => open('chromium', async (page) => {
    await page.locator('#fileInput').setInputFiles(await imageFixture(page, 'modes.png', 2, 1, ['red', 'green']));
    await ready(page, 'PNG (无损)');
    await on(page, 'export');
    await click(page, '[data-mode="lossy"]');
    await click(page, '[data-quality="55"]');
    await ready(page, 'PNG (质量 55/100)');
    await format(page, 'bmp');
    assert.equal(await page.locator('[data-mode="lossless"]').isDisabled(), true);
    await ready(page, 'BMP (未压缩)');
    await format(page, 'png');
    await ready(page, 'PNG (质量 55/100)');
    await click(page, '[data-mode="lossless"]');
    await format(page, 'bmp');
    await format(page, 'jpeg');
    await ready(page, 'JPEG (最高画质（非无损）)');
  }));

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
    assert.equal(await page.locator('#estimatedSizeLabel').textContent(), '—');
    assert.equal(await page.locator('#sizeDeltaPill').textContent(), '');
    await page.evaluate(() => window.pendingEncodes[1].release());
    await ready(page, '9×1 · PNG');
    const size = await page.locator('#estimatedSizeLabel').textContent();
    await type(page, '#inpResizeW', 10);
    await page.waitForFunction(() => window.pendingEncodes.length === 3);
    await type(page, '#inpResizeW', 9);
    await ready(page, '9×1 · PNG');
    assert.equal(await page.locator('#estimatedSizeLabel').textContent(), size);
    await page.evaluate(() => window.pendingEncodes[2].release());
  }));

  test('chromium: metadata failures cannot export the cached unverified bytes', { timeout: 30000 }, () => open('chromium', async (page) => {
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
    await type(page, '#exifArtist', 'Edited artist');
    await page.waitForFunction(() => document.querySelector('#m3Snackbar').textContent.includes('无法写入 EXIF'));
    assert.equal(await page.locator('#btnDownloadExport').isDisabled(), true);
    await click(page, 'label:has(#chkStripExif)');
    assert.equal(await page.locator('#chkStripExif').isChecked(), true);
    await page.waitForFunction(() => document.querySelector('#m3Snackbar').textContent.includes('无法确认 EXIF 已清除'));
    assert.equal(await page.locator('#btnDownloadExport').isDisabled(), true);
    assert.match(await page.locator('#exportSpecSummary').textContent(), /无法确认 EXIF 已清除/);
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

  test('chromium: a theme override survives unavailable storage and OS changes', { timeout: 30000 }, () => open('chromium', async (page) => {
    const trigger = page.locator('#btnThemeToggle');
    assert.equal(await page.locator('html').getAttribute('data-seed'), null);
    assert.equal(await trigger.getAttribute('aria-pressed'), 'false');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await click(page, '#btnThemeToggle');
    assert.equal(await trigger.getAttribute('aria-pressed'), 'false');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('html').getAttribute('data-theme'), null);
  }, { colorScheme: 'light' }, () => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      return key === 'pixelstudio.prefs' ? '{"seed":"constructor"}' : get.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === 'pixelstudio.prefs') throw new DOMException('Storage blocked', 'SecurityError');
      return set.call(this, key, value);
    };
  }));

  test('chromium: an unchanged output size is not reported as savings', { timeout: 30000 }, () => open('chromium', async (page) => {
    await page.locator('#fileInput').setInputFiles(await imageFixture(page, 'one.png', 1, 1, ['red']));
    await ready(page, '1×1 · PNG');
    await on(page, 'export');
    await format(page, 'bmp');
    await ready(page, '1×1 · BMP');
    const bmp = await download(page);
    await page.locator('#fileInput').setInputFiles({ name: 'same.bmp', mimeType: 'image/bmp', buffer: bmp.bytes });
    await page.waitForFunction(() => document.querySelector('#fileNameLabel').textContent === 'same.bmp');
    await ready(page, '1×1 · BMP');
    assert.equal(await page.locator('#sizeDeltaPill').textContent(), '体积不变');
  }));

  test('chromium: size metrics and save stay in a very narrow or short dock', { timeout: 30000 }, () => open('chromium', async (page) => {
    const footer = page.locator('.export-sticky-footer');
    await page.locator('#sizeDeltaPill').evaluate((el) => { el.textContent = '+1920000000.0%'; });
    await page.locator('#estimatedSizeLabel').evaluate((el) => { el.textContent = '183.1 MB'; });
    assert.equal(await footer.evaluate((el) => el.scrollWidth <= el.clientWidth), true);
    await page.setViewportSize({ width: 1024, height: 200 });
    await on(page, 'export');
    const nav = page.locator('.nav-rail');
    assert.ok(await nav.evaluate((el) => el.scrollTop > 0));
    const save = await page.locator('#btnDownloadExport').boundingBox();
    assert.ok(save.y + save.height <= 200);
    assert.equal(await page.locator('.inspector-scroll').evaluate((el) => el.clientHeight > 0), true);
  }, { viewport: { width: 320, height: 390 } }));

  test('chromium: extremely short mobile workspace scrolls from preview to export', { timeout: 30000 }, () => open('chromium', async (page) => {
    await click(page, '#btnLoadDemo');
    await ready(page, 'JPEG');
    await on(page, 'export');
    assert.equal(await page.locator('#panel-export').isVisible(), true);
    const workspace = page.locator('.workspace-body');
    assert.ok(await workspace.evaluate((el) => el.scrollTop > 0));
    await workspace.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const save = await page.locator('#btnDownloadExport').boundingBox();
    const nav = await page.locator('.nav-rail').boundingBox();
    assert.ok(save.y + save.height <= nav.y);
  }, { viewport: { width: 320, height: 240 }, isMobile: true, hasTouch: true }));

  test('chromium: abnormal theme storage and short mobile viewport', { timeout: 30000 }, () => open('chromium', async (page) => {
    const trigger = page.locator('#btnSeedMobile');
    await trigger.press('Enter');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    const focused = () => page.evaluate(() => document.activeElement.dataset.seed);
    assert.equal(await focused(), 'teal');
    await page.keyboard.press('Tab');
    assert.equal(await focused(), 'violet');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('html').getAttribute('data-seed'), 'violet');
    assert.equal(await trigger.evaluate((el) => document.activeElement === el), true);
    await trigger.press('Enter');
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
