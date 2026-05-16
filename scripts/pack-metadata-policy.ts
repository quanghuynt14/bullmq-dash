export const EXPECTED_PACK_ENTRY_COUNT = 4;
export const MAX_PACKED_SIZE_BYTES = 64 * 1024;
export const MAX_UNPACKED_SIZE_BYTES = 256 * 1024;

export interface PackMetadata {
  size?: unknown;
  unpackedSize?: unknown;
  entryCount?: unknown;
  bundled?: unknown;
}

export function assertPackMetadataPolicy(pack: PackMetadata): void {
  if (pack.entryCount !== EXPECTED_PACK_ENTRY_COUNT) {
    throw new Error(`Packed tarball must contain exactly ${EXPECTED_PACK_ENTRY_COUNT} files`);
  }

  if (typeof pack.size !== "number" || pack.size > MAX_PACKED_SIZE_BYTES) {
    throw new Error(`Packed tarball must be at most ${MAX_PACKED_SIZE_BYTES} bytes`);
  }

  if (typeof pack.unpackedSize !== "number" || pack.unpackedSize > MAX_UNPACKED_SIZE_BYTES) {
    throw new Error(`Packed tarball must unpack to at most ${MAX_UNPACKED_SIZE_BYTES} bytes`);
  }

  if (Array.isArray(pack.bundled) && pack.bundled.length > 0) {
    throw new Error("Packed tarball must not contain bundled dependencies");
  }

  if (pack.bundled !== undefined && !Array.isArray(pack.bundled)) {
    throw new Error("Packed tarball bundled metadata must be an array when present");
  }
}

export function formatPackMetadata(pack: PackMetadata): string {
  return `${String(pack.entryCount)} files, ${String(pack.size)} packed bytes, ${String(
    pack.unpackedSize,
  )} unpacked bytes, no bundled dependencies`;
}
