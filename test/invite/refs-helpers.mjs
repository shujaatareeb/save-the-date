export function referenceScreenshotOptions(measuredHeight, width = 1366) {
  if (!Number.isInteger(measuredHeight) || measuredHeight <= 0) {
    throw new RangeError(`measured height must be a positive integer: ${measuredHeight}`);
  }
  return { fullPage: true, clip: { x: 0, y: 0, width, height: measuredHeight } };
}
