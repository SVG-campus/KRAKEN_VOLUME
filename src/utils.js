/**
 * Calculates the percentage change between two volume numbers.
 * @param {number|null} prevVolume - The previous 24h volume.
 * @param {number} currentVolume - The current 24h volume.
 * @returns {number|null} The percentage change, or null if prevVolume is not available.
 */
export function calcVolumePctChange(prevVolume, currentVolume) {
  if (prevVolume === null || prevVolume === 0) {
    return null;
  }
  return ((currentVolume - prevVolume) / prevVolume) * 100;
}

/**
 * Calculates the percentage change between open and last price.
 * @param {number} openPrice - The opening price for the period.
 * @param {number} lastPrice - The last traded price.
 * @returns {number} The percentage change.
 */
export function calcPriceChangePct(openPrice, lastPrice) {
  if (openPrice === 0) {
    return 0;
  }
  return ((lastPrice - openPrice) / openPrice) * 100;
}

/**
 * Calculates the "volume velocity" - the rate of change of the volume percentage, in % per hour.
 * @param {number|null} prevPct - The previous volume percentage change.
 * @param {number} currentPct - The current volume percentage change.
 * @param {number} intervalMs - The time in milliseconds between the two measurements.
 * @returns {number|null} The velocity in percent per hour, or null if data is incomplete.
 */
export function calcVolumeVelocity(prevPct, currentPct, intervalMs) {
  if (prevPct === null || currentPct === null || !intervalMs) {
    return null;
  }
  const intervalHours = intervalMs / (1000 * 60 * 60);
  const pctChange = currentPct - prevPct;
  return pctChange / intervalHours;
}

import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}