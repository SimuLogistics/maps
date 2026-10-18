// Reads a .pmd v4 model descriptor: looks, variants, and the per-variant
// attribute values that tell which parts are visible in each variant.
// Header: 16 × uint32 (version, material count, look count, piece count,
// variant count, part count, attribute count, attribute values size,
// material block size, then offsets of looks, variants, part attributes,
// attribute values and attributes).

const TOKEN_LETTERS = [...'\x000123456789abcdefghijklmnopqrstuvwxyz_'];
function tokenToString(n: bigint): string {
  let str = '';
  do {
    str += TOKEN_LETTERS[Number(n % 38n)];
    n /= 38n;
  } while (n !== 0n);
  return str.replaceAll('\x00', '');
}

export interface PmdDescriptor {
  looks: string[];
  variants: string[];
  attributes: { name: string; type: number; offset: number }[];
  // values[variantIndex][attributeIndex]
  values: number[][];
}

export function parseModelPmd(buffer: Buffer): PmdDescriptor {
  const h = Array.from({ length: 16 }, (_, i) => buffer.readUInt32LE(i * 4));
  const [
    version,
    ,
    lookCount,
    ,
    variantCount,
    ,
    attribCount,
    attribValuesSize,
    ,
    lookOffset,
    variantOffset,
    ,
    attribValuesOffset,
    attribsOffset,
  ] = h;
  if (version !== 4) {
    throw new Error(`unknown .pmd file version ${version}`);
  }
  const looks = Array.from({ length: lookCount }, (_, i) =>
    tokenToString(buffer.readBigUInt64LE(lookOffset + i * 8)),
  );
  const variants = Array.from({ length: variantCount }, (_, i) =>
    tokenToString(buffer.readBigUInt64LE(variantOffset + i * 8)),
  );
  const attributes = Array.from({ length: attribCount }, (_, i) => {
    const o = attribsOffset + i * 16;
    return {
      name: tokenToString(buffer.readBigUInt64LE(o)),
      type: buffer.readInt32LE(o + 8),
      offset: buffer.readUInt32LE(o + 12),
    };
  });
  const values = variants.map((_, vi) =>
    attributes.map(a =>
      buffer.readInt32LE(attribValuesOffset + vi * attribValuesSize + a.offset),
    ),
  );
  return { looks, variants, attributes, values };
}
