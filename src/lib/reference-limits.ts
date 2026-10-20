export const MAX_REFERENCE_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_INLINE_REFERENCE_BYTES = 6_000_000;
export const MAX_IMAGE_REFERENCES = 9;

// Round up so an overage of even one byte is visible in the validation message.
export function referenceSize(bytes: number) {
  return `${(Math.ceil(bytes / 10_000) / 100).toFixed(2)} MB`;
}
