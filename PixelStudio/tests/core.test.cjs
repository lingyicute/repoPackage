const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const { deflateSync } = require('node:zlib');

// Exercise the deployed inline code without adding exports or dependencies to index.html.
const init = 'bindEvents();\n      bindPressedState();';
const html = readFileSync(join(__dirname, '../index.html'), 'utf8');
const source = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g), ([, script]) => script)
  .find((script) => script.includes(init));
assert.ok(source, 'The application script must contain the initialization hook');
const el = { addEventListener() {}, setAttribute() {} };
const { ExifEngine: exif, CodecHelper: codecs, fitResizeScales, cropRatioMatches, makeDownloadFilename } = runInNewContext(
  source.replace(init, 'return { ExifEngine, CodecHelper, fitResizeScales, cropRatioMatches, makeDownloadFilename };'),
  { document: { getElementById: () => el }, window: el, navigator: {}, TextDecoder, TextEncoder, Blob, DecompressionStream }
);
const arrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const parse = (bytes) => exif.parse(arrayBuffer(bytes));

const sig = Buffer.from('89504e470d0a1a0a', 'hex');
const ihdr = Buffer.from('00000001000000010806000000', 'hex');
function pngChunk(type, data = Buffer.alloc(0)) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length);
  out.write(type, 4, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(exif._crc32(out.subarray(4, -4)), out.length - 4);
  return out;
}
function png(...metadata) {
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), ...metadata,
    pngChunk('IDAT', deflateSync(Buffer.from([0, 10, 20, 30, 255]))), pngChunk('IEND')]);
}
const ascii = (s) => Buffer.from(s, 'ascii');
const textData = (s, bytes) => Buffer.concat([ascii(s), Buffer.from(bytes)]);
const jpeg = (...segments) => Buffer.concat([Buffer.from('ffd8', 'hex'), ...segments, Buffer.from('ffd9', 'hex')]);
function riffChunk(tag, data) {
  const chunk = Buffer.alloc(8 + data.length + (data.length & 1));
  chunk.write(tag);
  chunk.writeUInt32LE(data.length, 4);
  Buffer.from(data).copy(chunk, 8);
  return chunk;
}
function webp(...chunks) {
  const data = Buffer.concat([ascii('RIFF\0\0\0\0WEBP'), ...chunks]);
  data.writeUInt32LE(data.length - 8, 4);
  return data;
}
function ifdEntry(tiff, offset, tag) {
  for (let i = 0; i < tiff.readUInt16LE(offset); i++) {
    const ent = offset + 2 + 12 * i;
    if (tiff.readUInt16LE(ent) === tag) return ent;
  }
  assert.fail(`TIFF fixture has no tag ${tag.toString(16)}`);
}
const ifdPointer = (tiff, ifd, tag) => tiff.readUInt32LE(ifdEntry(tiff, ifd, tag) + 8);

test('PNG decodes Latin-1, zTXt and compressed UTF-8 iTXt', async () => {
  assert.equal(exif._crc32(ascii('123456789')), 0xcbf43926);
  const bytes = png(
    pngChunk('tEXt', textData('Copyright\0', [0xc3, 0xa9])), // Two separate Latin-1 chars, not UTF-8 é.
    pngChunk('zTXt', textData('Author\0\0', deflateSync(Buffer.from('Müller', 'latin1')))),
    pngChunk('iTXt', textData('Description\0\x01\0zh\0\0', deflateSync(Buffer.from('像素配色')))),
    pngChunk('zTXt', textData('Creation Time\0\0', deflateSync(ascii('Tue, 02 Jan 2024 15:04:05 +0000'))))
  );
  const result = await parse(bytes);
  assert.equal(result.copyright, 'Ã©');
  assert.equal(result.artist, 'Müller');
  assert.equal(result.description, '像素配色');
  assert.equal(result.dateTime, '2024:01:02 15:04:05');
});

test('PNG ignores invalid CRC and over-limit decompression, and prioritizes EXIF', async () => {
  const badCrc = pngChunk('tEXt', ascii('Software\0invalid'));
  badCrc[badCrc.length - 1] ^= 0xff;
  const compressed = pngChunk('zTXt', textData('Description\0\0', deflateSync(Buffer.alloc(40000, 65))));
  const badMethod = pngChunk('iTXt', textData('Description\0\x00\x01\0\0', ascii('invalid method')));
  const fallback = pngChunk('tEXt', ascii('Description\0fallback'));
  const textDate = pngChunk('tEXt', ascii('Creation Time\0Tue, 02 Jan 2024 15:04:05 +0000'));
  const tiffDate = pngChunk('eXIf', exif.buildTiffBuffer({ dateTime: '2021:03:04 05:06:07' }));
  for (const dates of [[textDate, tiffDate], [tiffDate, textDate]]) {
    const result = await parse(png(badCrc, compressed, badMethod, fallback, ...dates));
    assert.equal(result.description, 'fallback');
    assert.equal(result.software, '');
    assert.equal(result.dateTime, '2021:03:04 05:06:07');
  }
});

test('JPEG skips a bad EXIF header, but never reads past a truncated segment', async () => {
  const good = exif.processJpegBytes(jpeg(), false, { make: 'Test camera' }, { w: 1, h: 1 });
  const badApp1 = Buffer.from('ffe10008457869660000', 'hex');
  assert.equal((await parse(jpeg(badApp1, good.subarray(2, -2)))).make, 'Test camera');
  const truncated = Buffer.from(good);
  truncated.writeUInt16BE(65535, 4);
  assert.equal((await parse(truncated)).hasExif, false);
  assert.equal((await parse(exif.processJpegBytes(good, true))).hasExif, false);
});

test('JPEG stripping keeps scan bytes and requires a complete end marker', async () => {
  const scan = Buffer.from('ffda0008010100003f0040ff0020ffd041', 'hex');
  const tagged = exif.processJpegBytes(jpeg(), false, { artist: 'Test artist' });
  const app1 = tagged.subarray(2, -2);
  const comment = Buffer.from('fffe00047478', 'hex');
  const multi = Buffer.concat([jpeg(scan, comment, app1, scan), ascii('trailing data')]);
  assert.equal((await parse(multi)).artist, 'Test artist');
  assert.deepEqual(Buffer.from(exif.processJpegBytes(multi, true)), jpeg(scan, scan));
  assert.throws(() => exif.processJpegBytes(jpeg(scan).subarray(0, -2), true), /JPEG/);
});

test('WebP bounds EXIF by the RIFF size and cleans feature flags on strip', async () => {
  const base = webp(riffChunk('VP8L', Buffer.from([0x2f, 0, 0, 0, 0])));
  const added = Buffer.from(exif.injectWebpExif(base, false, { artist: 'Camera' }, 1, 1));
  assert.equal(added.subarray(12, 16).toString(), 'VP8X');
  assert.equal(added[20] & 8, 8);
  assert.equal((await parse(added)).artist, 'Camera');
  assert.deepEqual(Buffer.from(exif.injectWebpExif(added, true)), base);
  const outsideRiff = Buffer.concat([base, riffChunk('EXIF', exif.buildTiffBuffer({ make: 'Not inside RIFF' }))]);
  assert.equal((await parse(outsideRiff)).hasExif, false);
  assert.deepEqual(Buffer.from(exif.injectWebpExif(outsideRiff, true)), base);
  assert.throws(() => exif.injectWebpExif(added.subarray(0, -1), true), /WebP/);
});

test('WebP inserts EXIF before XMP, keeps alpha, and validates padding', () => {
  const header = Buffer.from([0x14, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const image = riffChunk('VP8L', Buffer.from([0x2f, 0, 0, 0, 0x10]));
  const xmp = riffChunk('XMP ', ascii('original'));
  const source = webp(riffChunk('VP8X', header), image, xmp);
  const added = Buffer.from(exif.injectWebpExif(source, false, { make: 'Camera' }, 1, 1));
  const chunks = exif._webpChunks(new DataView(arrayBuffer(added))).chunks;
  assert.equal(added[20], 0x1c);
  assert.equal(chunks.map((item) => item.fourcc).join(','), 'VP8X,VP8L,EXIF,XMP ');
  assert.equal(Buffer.from(chunks[3].payload).toString(), 'original');
  const stripped = Buffer.from(exif.injectWebpExif(added, true));
  assert.equal(stripped[20], 0x10);
  assert.deepEqual(stripped.subarray(30), image);
  const badPadding = Buffer.from(image);
  badPadding[badPadding.length - 1] = 1;
  assert.throws(() => exif.injectWebpExif(webp(badPadding), true), /WebP/);
});

test('PNG stripping removes text, EXIF and trailing data, but rejects a missing IEND', async () => {
  const base = png();
  const withText = png(pngChunk('tEXt', ascii('Author\0Private')));
  const tagged = exif.injectPngExif(withText, false, { gpsLat: '10', gpsLng: '-20' }, { w: 1, h: 1 });
  assert.equal((await parse(tagged)).gpsLng, '-20');
  const extended = Buffer.concat([tagged, ascii('trailing text')]);
  assert.deepEqual(Buffer.from(exif.injectPngExif(extended, true)), base);
  assert.throws(() => exif.injectPngExif(tagged.subarray(0, -12), true), /PNG/);
});

test('GPS uses explicit valid hemispheres and well-formed DMS', async () => {
  const tiff = Buffer.from(exif.buildTiffBuffer({ gpsLat: '47.5', gpsLng: '-122.3' }));
  assert.equal((await parse(png(pngChunk('eXIf', tiff)))).gpsLng, '-122.3');
  const dir = ifdPointer(tiff, 8, 0x8825);
  tiff.writeUInt16LE(0x9999, ifdEntry(tiff, dir, 1)); // Remove latitude direction while keeping a nonzero magnitude.
  const dms = ifdPointer(tiff, dir, 4);
  tiff.writeUInt32LE(610000, dms + 16); // 61 arc-seconds with denominator 10000.
  const result = await parse(png(pngChunk('eXIf', tiff)));
  assert.equal(result.gpsLat, '');
  assert.equal(result.gpsLng, '');
  const zero = exif.buildTiffBuffer({ gpsLat: '0', gpsLng: '0' });
  assert.equal((await parse(png(pngChunk('eXIf', zero)))).gpsLat, '0');
});

test('TIFF text reads only a bounded, complete field', async () => {
  const long = Buffer.alloc(40000, 65);
  assert.equal(exif._readAscii(new DataView(arrayBuffer(long)), 0, long.length), '');
  Buffer.from('像素\0').copy(long);
  assert.equal(exif._readAscii(new DataView(arrayBuffer(long)), 0, long.length), '像素');
  const metadata = { artist: '林', description: '像素🙂' };
  const result = await parse(png(pngChunk('eXIf', exif.buildTiffBuffer(metadata))));
  assert.equal(result.artist, metadata.artist);
  assert.equal(result.description, metadata.description);
});

test('DateTimeDigitized outranks modification time if DateTimeOriginal is absent', async () => {
  const tiff = Buffer.from(exif.buildTiffBuffer({ dateTime: '2021:03:04 05:06:07' }));
  const sub = ifdPointer(tiff, 8, 0x8769);
  const date = () => parse(png(pngChunk('eXIf', tiff)));
  const original = ifdPointer(tiff, sub, 0x9003);
  tiff.write('2022:02:02 00:00:00', ifdPointer(tiff, sub, 0x9004));
  assert.equal((await date()).dateTime, '2021:03:04 05:06:07');
  tiff[original] = 0;
  assert.equal((await date()).dateTime, '2022:02:02 00:00:00');
  assert.equal(exif.normalizeDate('2024-02-29T12:34:56.3+08:00'), '2024:02:29 12:34:56');
  assert.equal(exif.normalizeDate('2023-02-29'), '');
});

test('Shutter values close to a unit fraction are not rounded to it', async () => {
  assert.equal(exif.canonicalExposure('1/32000 s'), '1/32000');
  assert.equal(exif.canonicalExposure('0.499'), '0.499');
  assert.equal(exif.canonicalExposure('1/0 sec'), '');
  for (const seconds of [0.499, 0.008031, 1 / 32000, 7200.125]) {
    const tiff = exif.buildTiffBuffer({ exposureTime: String(seconds), iso: '409600' });
    const result = await parse(png(pngChunk('eXIf', tiff)));
    assert.ok(Math.abs(exif.parseExposure(result.exposureTime) - seconds) < 1e-8);
    assert.equal(result.iso, '409600');
  }
});

test('EXIF sensitivity and fixed-point fields round trip at their declared limits', async () => {
  const tiff = exif.buildTiffBuffer({ iso: '4294967295', fNumber: '0.01', focalLength: '42949672.95' });
  const result = await parse(png(pngChunk('eXIf', tiff)));
  assert.equal(result.iso, '4294967295');
  assert.equal(result.fNumber, '0.01');
  assert.equal(result.focalLength, '42949672.95');
  assert.equal(exif.parsePositiveFixed('42949672.96'), 0);
});

test('EXIF component order matches RGB and YCbCr image encodings', () => {
  const components = (bytes) => {
    const tiff = Buffer.from(bytes);
    const sub = ifdPointer(tiff, 8, 0x8769);
    const entry = ifdEntry(tiff, sub, 0x9101);
    assert.equal(tiff.readUInt16LE(entry + 2), 7);
    assert.equal(tiff.readUInt32LE(entry + 4), 4);
    return [...tiff.subarray(entry + 8, entry + 12)];
  };
  assert.deepEqual(components(exif.buildTiffBuffer({}, { w: 1, h: 1 })), [4, 5, 6, 0]);
  assert.deepEqual(components(exif.buildTiffBuffer({}, { w: 1, h: 1 }, true)), [1, 2, 3, 0]);

  for (const [fourcc, expected] of [['VP8L', [4, 5, 6, 0]], ['VP8 ', [1, 2, 3, 0]]]) {
    const image = webp(riffChunk(fourcc, Buffer.from([0x2f, 0, 0, 0, 0])));
    const encoded = exif.injectWebpExif(image, false, {}, 1, 1);
    const chunks = exif._webpChunks(new DataView(arrayBuffer(encoded))).chunks;
    const payload = chunks.find((chunk) => chunk.fourcc === 'EXIF').payload;
    assert.deepEqual(components(Buffer.from(payload)), expected);
  }
});

test('Rounded resize dimensions obey both browser limits', () => {
  for (const [w, h, sx, sy] of [[8000, 8000, 3, 3], [1600, 1066, 10, 10], [1, 16383, 0.0001, 100],
    [8000, 8000, 8, 0.5], [16383, 3906, 5, 5], [2, 2, 0.01, 0.01]]) {
    const d = fitResizeScales(w, h, sx, sy);
    assert.ok(d.w >= 1 && d.h >= 1 && Math.max(d.w, d.h) <= 16383 && d.w * d.h <= 64000000);
    assert.ok(d.limit > 0 && d.limit <= 1);
  }
  const native = fitResizeScales(8000, 8000, 1, 1);
  assert.equal(native.limit, 1);
  assert.equal(native.w * native.h, 64000000);
  assert.equal(fitResizeScales(1, 400, 0.5, 0.5).h, 200);
});

test('Crop ratios allow integer rounding, not a two-percent manual mismatch', () => {
  assert.equal(cropRatioMatches(1600, 900, 16 / 9), true);
  assert.equal(cropRatioMatches(1600, 1066, 3 / 2), true); // One-pixel rounding is unavoidable here.
  assert.equal(cropRatioMatches(101, 100, 1), true);
  assert.equal(cropRatioMatches(1600, 910, 16 / 9), false);
  assert.equal(cropRatioMatches(102, 100, 1), false);
  assert.equal(cropRatioMatches(0, 100, 1), false);
  assert.equal(cropRatioMatches(100, 100, Infinity), false);
});

test('BMP is padded bottom-up BGR and composites transparent pixels', async () => {
  const bmp = await codecs.encodeBmp({ width: 1, height: 2, data: new Uint8ClampedArray([255, 0, 5, 255, 0, 0, 0, 0]) }).arrayBuffer();
  const buf = Buffer.from(bmp);
  assert.equal(buf.readUInt16LE(28), 24);
  assert.equal(buf.length, 62);
  assert.deepEqual([...buf.subarray(54)], [255, 255, 255, 0, 5, 0, 255, 0]);
});

test('Download names include the extension within the UTF-8 budget', () => {
  assert.equal(makeDownloadFilename('COM¹.log.jpg .', 'png'), '_COM¹.log.png');
  assert.equal(makeDownloadFilename('AUX .log', 'bmp'), '_AUX .log.bmp');
  assert.equal(makeDownloadFilename('... ', 'jpg'), 'pixelstudio_output.jpg');
  assert.equal(makeDownloadFilename('a/b:c?', 'png'), 'a_b_c_.png');
  const utf8 = makeDownloadFilename('像🙂'.repeat(120), 'jpeg');
  assert.ok(Buffer.byteLength(utf8) <= 255);
  assert.match(utf8, /^(像🙂)*像?\.jpeg$/u);
});
