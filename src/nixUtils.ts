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
  hash: string,
  {
    storePath = `/nix/store` as PortablePath,
    recursive = false,
  }: { storePath?: PortablePath; recursive?: boolean } = {},
) => {
  const [hashAlgorithm, hash64] = hash.split("-");
  const hashHex = Buffer.from(hash64, "base64").toString("hex");

  const rec = recursive ? "r:" : "";
  const innerStr = `fixed:out:${rec}${hashAlgorithm}:${hashHex}:`;
  const innerHash = computeHash(`sha256`, innerStr);
  const innerHashHex = innerHash.toString("hex");

  const outerStr = `output:out:sha256:${innerHashHex}:${storePath}:${name}`;
  const outerHash = computeHash(`sha256`, outerStr);
  const outerHash32 = encodeBase32(compressHash(outerHash, 20));

  return ppath.join(storePath, `${outerHash32}-${name}` as Filename);
};

/**
 * Creates a valid derivation name from a potentially invalid one.
 *
 * Matches lib.strings.sanitizeDerivationName in Nixpkgs.
 */
export const sanitizeDerivationName = (name: string) =>
  name
    .replace(/^\.+/, "")
    .replace(/[^a-zA-Z0-9+._?=-]+/g, "-")
    .slice(0, 207) || "unknown";

/** Convert a hexadecimal hash to an SRI hash. */
export const hexToSri = (hash: string, algorithm = "sha512") =>
  algorithm + "-" + Buffer.from(hash, "hex").toString("base64");

/** Convert an SRI hash to a hexadecimal hash. */
export const sriToHex = (hash: string) =>
  Buffer.from(hash.split("-")[1], "base64").toString("hex");
