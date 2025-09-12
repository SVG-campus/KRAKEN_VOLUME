import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcVolumePctChange, calcPriceChangePct, calcVolumeVelocity } from '../src/utils.js';

test('calcVolumePctChange handles baseline and changes', () => {
  assert.equal(calcVolumePctChange(null, 100), null);
  assert.equal(calcVolumePctChange(100, 110), 10);
  assert.equal(calcVolumePctChange(100, 90), -10);
});

test('calcPriceChangePct returns correct percent', () => {
  assert.equal(calcPriceChangePct(100, 110), 10);
  assert.equal(calcPriceChangePct(100, 90), -10);
});

test('calcVolumeVelocity returns per-hour rate', () => {
  assert.equal(calcVolumeVelocity(10, 20, 3600000), 10);
  assert.equal(calcVolumeVelocity(10, 40, 1800000), 60);
  assert.equal(calcVolumeVelocity(null, 40, 1800000), null);
});
