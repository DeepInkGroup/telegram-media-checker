import { test } from 'node:test';
import assert from 'node:assert/strict';
import MediaInfo from 'mediainfo.js';

test('media analyzer reads an image without starting a subprocess', async () => {
  const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aKsAAAAASUVORK5CYII=', 'base64');
  const analyzer = await MediaInfo({ format: 'object' });
  try {
    const result = await analyzer.analyzeData(() => data.length, (size, offset) => data.subarray(offset, offset + size));
    assert.equal(result.media.track[0].Format, 'PNG');
    const image = result.media.track.find(track => track['@type'] === 'Image');
    assert.equal(Number(image.Width), 1);
    assert.equal(Number(image.Height), 1);
  } finally { analyzer.close(); }
});
