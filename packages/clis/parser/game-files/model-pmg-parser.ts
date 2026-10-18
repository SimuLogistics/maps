import type { ModelDescription } from '@truckermudgeon/map/types';
import { logger } from '../logger';
import { float3, r, uint64le } from './binary-parser';

// based on https://github.com/sk-zk/TruckLib/blob/5b7ae044fef4d6541ff73dff39267231e6433810/TruckLib/Model/Model.cs

const PmgHeader = new r.Struct({
  version: r.uint8, // 21
  magic: new r.String(3), // "Pmg", but reversed
  numPieces: r.uint32le,
  numParts: r.uint32le,
  numBones: r.uint32le,
  weightWidth: r.uint32le,
  numLocators: r.uint32le,
  skeletonHash: uint64le,
  bboxCenter: float3,
  bboxDiagonal: r.floatle,
  bboxStart: float3,
  bboxEnd: float3,
  // ignore the rest.
});

export function parseModelPmg(buffer: Buffer): ModelDescription {
  const version = buffer.readUint8();
  if (version !== 21) {
    logger.error('unknown .pmg file version', version);
    throw new Error();
  }

  const header = PmgHeader.fromBuffer(buffer);
  if (header.magic !== 'gmP') {
    logger.error('unexpected pmg signature', header.magic);
    throw new Error();
  }

  const [cx, , cz] = header.bboxCenter;
  const [sx, sy, sz] = header.bboxStart;
  const [ex, ey, ez] = header.bboxEnd;

  return {
    center: { x: cx, y: cz },
    start: { x: sx, y: sz },
    end: { x: ex, y: ez },
    height: ey - sy,
  };
}

// Locators of a .pmg v21, with the part each one belongs to. Used to find
// the hookups (e.g. `tollgate.*` toll booths) placed in a prefab's model.
// Layout (cf. TruckLib Model.cs): header offsets at 72 (parts +4,
// locators +8, string pool +16, pool size +20); a part is 24 bytes (name
// token, …, locator count @16, first locator @20); a locator is 44 bytes
// (name token, position, scale, quaternion, hookup offset in the pool).

export interface PmgLocator {
  name: string;
  x: number;
  y: number;
  z: number;
  scale: number;
  // raw quaternion, in file order
  rotation: [number, number, number, number];
  hookup: string | undefined;
  // index into `PmgLocators.parts`, -1 if the locator is in no part
  part: number;
}

export interface PmgLocators {
  parts: string[];
  locators: PmgLocator[];
}

const TOKEN_LETTERS = [...'\x000123456789abcdefghijklmnopqrstuvwxyz_'];
function tokenToString(n: bigint): string {
  let str = '';
  do {
    str += TOKEN_LETTERS[Number(n % 38n)];
    n /= 38n;
  } while (n !== 0n);
  return str.replaceAll('\x00', '');
}

export function parseModelPmgLocators(buffer: Buffer): PmgLocators {
  const version = buffer.readUint8();
  if (version !== 21) {
    logger.error('unknown .pmg file version', version);
    throw new Error();
  }
  const numParts = buffer.readUInt32LE(8);
  const numLocators = buffer.readUInt32LE(20);
  const partsOffset = buffer.readInt32LE(72 + 4);
  const locatorsOffset = buffer.readInt32LE(72 + 8);
  const poolOffset = buffer.readInt32LE(72 + 16);
  const poolSize = buffer.readInt32LE(72 + 20);

  const parts: { name: string; from: number; count: number }[] = [];
  for (let i = 0; i < numParts; i++) {
    const o = partsOffset + i * 24;
    parts.push({
      name: tokenToString(buffer.readBigUInt64LE(o)),
      count: buffer.readUInt32LE(o + 16),
      from: buffer.readUInt32LE(o + 20),
    });
  }

  const locators: PmgLocator[] = [];
  for (let i = 0; i < numLocators; i++) {
    const o = locatorsOffset + i * 44;
    const hookupOffset = buffer.readInt32LE(o + 40);
    let hookup: string | undefined;
    if (hookupOffset >= 0 && hookupOffset < poolSize) {
      const start = poolOffset + hookupOffset;
      hookup = buffer.toString('latin1', start, buffer.indexOf(0, start));
    }
    locators.push({
      name: tokenToString(buffer.readBigUInt64LE(o)),
      x: buffer.readFloatLE(o + 8),
      y: buffer.readFloatLE(o + 12),
      z: buffer.readFloatLE(o + 16),
      scale: buffer.readFloatLE(o + 20),
      rotation: [
        buffer.readFloatLE(o + 24),
        buffer.readFloatLE(o + 28),
        buffer.readFloatLE(o + 32),
        buffer.readFloatLE(o + 36),
      ],
      hookup,
      part: parts.findIndex(p => i >= p.from && i < p.from + p.count),
    });
  }

  return { parts: parts.map(p => p.name), locators };
}
