import { parseModelPmd } from '../model-pmd-parser';
import { parseModelPmgLocators } from '../model-pmg-parser';

const LETTERS = '\x000123456789abcdefghijklmnopqrstuvwxyz_';
function token(s: string): bigint {
  let n = 0n;
  for (const c of [...s].reverse()) {
    n = n * 38n + BigInt(LETTERS.indexOf(c));
  }
  return n;
}

describe('parseModelPmgLocators', () => {
  it('reads parts, locators and hookups of a .pmg v21', () => {
    const partsOffset = 100;
    const locatorsOffset = partsOffset + 2 * 24;
    const poolOffset = locatorsOffset + 2 * 44;
    const pool = Buffer.from('tollgate.end\0', 'latin1');
    const b = Buffer.alloc(poolOffset + pool.length);
    b.writeUInt8(21, 0);
    b.writeUInt32LE(2, 8); // parts
    b.writeUInt32LE(2, 20); // locators
    b.writeInt32LE(partsOffset, 76);
    b.writeInt32LE(locatorsOffset, 80);
    b.writeInt32LE(poolOffset, 88);
    b.writeInt32LE(pool.length, 92);
    // part 0: no locator; part 1: locators 0..1
    b.writeBigUInt64LE(token('coll'), partsOffset);
    b.writeBigUInt64LE(token('start1'), partsOffset + 24);
    b.writeUInt32LE(2, partsOffset + 24 + 16);
    b.writeUInt32LE(0, partsOffset + 24 + 20);
    for (let i = 0; i < 2; i++) {
      const o = locatorsOffset + i * 44;
      b.writeBigUInt64LE(token(`l${i}`), o);
      b.writeFloatLE(1.5 + i, o + 8);
      b.writeFloatLE(2, o + 12);
      b.writeFloatLE(-3, o + 16);
      b.writeFloatLE(1, o + 20);
      b.writeFloatLE(1, o + 24);
      b.writeInt32LE(i === 0 ? 0 : -1, o + 40);
    }
    pool.copy(b, poolOffset);

    const { parts, locators } = parseModelPmgLocators(b);
    expect(parts).toEqual(['coll', 'start1']);
    expect(locators).toHaveLength(2);
    expect(locators[0]).toMatchObject({
      name: 'l0',
      x: 1.5,
      y: 2,
      z: -3,
      hookup: 'tollgate.end',
      part: 1,
      rotation: [1, 0, 0, 0],
    });
    expect(locators[1].hookup).toBeUndefined();
  });
});

describe('parseModelPmd', () => {
  it('reads looks, variants and per-variant attribute values', () => {
    const lookOffset = 64;
    const variantOffset = lookOffset + 8;
    const attribsOffset = variantOffset + 16;
    const valuesOffset = attribsOffset + 2 * 16;
    const b = Buffer.alloc(valuesOffset + 2 * 8);
    const header = [4, 0, 1, 0, 2, 2, 2, 8, 0];
    header.forEach((v, i) => b.writeUInt32LE(v, i * 4));
    b.writeUInt32LE(lookOffset, 36);
    b.writeUInt32LE(variantOffset, 40);
    b.writeUInt32LE(valuesOffset, 48);
    b.writeUInt32LE(attribsOffset, 52);
    b.writeBigUInt64LE(token('default'), lookOffset);
    b.writeBigUInt64LE(token('a2_1_start'), variantOffset);
    b.writeBigUInt64LE(token('a2_2_end'), variantOffset + 8);
    ['visible', 'visible'].forEach((n, i) => {
      b.writeBigUInt64LE(token(n), attribsOffset + i * 16);
      b.writeUInt32LE(i * 4, attribsOffset + i * 16 + 12);
    });
    b.writeInt32LE(1, valuesOffset);
    b.writeInt32LE(0, valuesOffset + 4);
    b.writeInt32LE(0, valuesOffset + 8);
    b.writeInt32LE(1, valuesOffset + 12);

    const pmd = parseModelPmd(b);
    expect(pmd.looks).toEqual(['default']);
    expect(pmd.variants).toEqual(['a2_1_start', 'a2_2_end']);
    expect(pmd.attributes.map(a => a.name)).toEqual(['visible', 'visible']);
    expect(pmd.values).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });
});
