import { describe, expect, it } from "bun:test";
import {
  assertPackMetadataPolicy,
  EXPECTED_PACK_ENTRY_COUNT,
  formatPackMetadata,
  MAX_PACKED_SIZE_BYTES,
  MAX_UNPACKED_SIZE_BYTES,
} from "./pack-metadata-policy.js";

const validPack = {
  size: 36_336,
  unpackedSize: 162_029,
  entryCount: EXPECTED_PACK_ENTRY_COUNT,
  bundled: [],
};

describe("assertPackMetadataPolicy", () => {
  it("accepts a small dist-only tarball without bundled dependencies", () => {
    expect(() => assertPackMetadataPolicy(validPack)).not.toThrow();
  });

  it("rejects unexpected tarball entry counts", () => {
    expect(() => assertPackMetadataPolicy({ ...validPack, entryCount: 5 })).toThrow(
      "Packed tarball must contain exactly 4 files",
    );
  });

  it("rejects oversized packed tarballs", () => {
    expect(() =>
      assertPackMetadataPolicy({ ...validPack, size: MAX_PACKED_SIZE_BYTES + 1 }),
    ).toThrow(`Packed tarball must be at most ${MAX_PACKED_SIZE_BYTES} bytes`);
  });

  it("rejects missing or nonnumeric packed size metadata", () => {
    expect(() => assertPackMetadataPolicy({ ...validPack, size: undefined })).toThrow(
      `Packed tarball must be at most ${MAX_PACKED_SIZE_BYTES} bytes`,
    );
    expect(() => assertPackMetadataPolicy({ ...validPack, size: "36219" })).toThrow(
      `Packed tarball must be at most ${MAX_PACKED_SIZE_BYTES} bytes`,
    );
  });

  it("rejects oversized unpacked tarballs", () => {
    expect(() =>
      assertPackMetadataPolicy({ ...validPack, unpackedSize: MAX_UNPACKED_SIZE_BYTES + 1 }),
    ).toThrow(`Packed tarball must unpack to at most ${MAX_UNPACKED_SIZE_BYTES} bytes`);
  });

  it("rejects missing or nonnumeric unpacked size metadata", () => {
    expect(() => assertPackMetadataPolicy({ ...validPack, unpackedSize: undefined })).toThrow(
      `Packed tarball must unpack to at most ${MAX_UNPACKED_SIZE_BYTES} bytes`,
    );
    expect(() => assertPackMetadataPolicy({ ...validPack, unpackedSize: "161662" })).toThrow(
      `Packed tarball must unpack to at most ${MAX_UNPACKED_SIZE_BYTES} bytes`,
    );
  });

  it("rejects bundled dependencies", () => {
    expect(() => assertPackMetadataPolicy({ ...validPack, bundled: ["ioredis"] })).toThrow(
      "Packed tarball must not contain bundled dependencies",
    );
  });

  it("rejects malformed bundled dependency metadata", () => {
    expect(() => assertPackMetadataPolicy({ ...validPack, bundled: "ioredis" })).toThrow(
      "Packed tarball bundled metadata must be an array when present",
    );
  });
});

describe("formatPackMetadata", () => {
  it("formats verifier evidence", () => {
    expect(formatPackMetadata(validPack)).toBe(
      "4 files, 36336 packed bytes, 162029 unpacked bytes, no bundled dependencies",
    );
  });
});
