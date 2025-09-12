export function calcVolumePctChange(prevVolume, currentVolume) {
  if (prevVolume === null || prevVolume <= 0) return null;
  return ((currentVolume - prevVolume) / prevVolume) * 100;
}

export function calcPriceChangePct(openPrice, lastPrice) {
  if (openPrice <= 0) throw new Error('openPrice must be positive');
  return ((lastPrice - openPrice) / openPrice) * 100;
}

export function calcVolumeVelocity(prevPct, currentPct, intervalMs) {
  if (prevPct === null || currentPct === null || intervalMs <= 0) return null;
  return (currentPct - prevPct) / (intervalMs / 3600000);
}
