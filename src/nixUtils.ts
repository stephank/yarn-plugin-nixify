import { createHash } from "crypto";
import { Filename, PortablePath, ppath } from "@yarnpkg/fslib";

const charset = "0123456789abcdfghijklmnpqrsvwxyz";

/**
 * Short-hand for simple hash computation.
 */
export const computeHash = (algorithm: string, data: string | Buffer) =>
  createHash(algorithm).update(data).digest();

/**
 * Nix-compatible hash compression.
 */
export const compressHash = (hash: Buffer, size: number) => {
  const result = Buffer.alloc(size);
  for (let idx = 0; idx < hash.length; idx++) {
    result[idx % size] ^= hash[idx];
  }
  return result;
};

/**
 * Nix-compatible base32 encoding.
 *
 * This is probably a super inefficient implementation, but we only process
 * small inputs. (20 bytes)
 */
export const encodeBase32 = (buf: Buffer) => {
  let result = ``;
  let bits = [...buf]
    .reverse()
    .map((n) => n.toString(2).padStart(8, `0`))
    .join(``);
  while (bits) {
    result += charset[parseInt(bits.slice(0, 5), 2)];
    bits = bits.slice(5);
  }
  return result;
};

/**
 * Compute the Nix store path for a fixed-output derivation.
 */
export const computeFixedOutputStorePath = (
  name: string,
  hashAlgorithm: string,
  hash: Buffer,
  storePath = `/nix/store` as PortablePath
) => {
  const hashHex = hash.toString("hex");

  const innerStr = `fixed:out:${hashAlgorithm}:${hashHex}:`;
  const innerHash = computeHash(`sha256`, innerStr);
  const innerHashHex = innerHash.toString("hex");

  const outerStr = `output:out:sha256:${innerHashHex}:${storePath}:${name}`;
  const outerHash = computeHash(`sha256`, outerStr);
  const outerHash32 = encodeBase32(compressHash(outerHash, 20));

  return ppath.join(storePath, `${outerHash32}-${name}` as Filename);
};
