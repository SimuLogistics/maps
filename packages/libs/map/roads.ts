import type { LaneSpeedClass, Road, RoadLook, RoadType } from './types';

export function getRoadType(look: RoadLook): RoadType {
  const lanes = look.lanesLeft.concat(look.lanesRight);
  if (lanes.length === 0) {
    // logger.warn(
    //   "trying to get road types without lane info. defaulting to 'local'"
    // );
    return 'local';
  }

  let roadType: RoadType = 'unknown';
  // prioritize types. assumes road looks can contain multiple types.
  if (lanes.some(l => l.includes('freeway') || l.includes('motorway'))) {
    roadType = 'freeway';
  } else if (
    lanes.some(l => l.includes('divided') || l.includes('expressway'))
  ) {
    roadType = 'divided';
  } else if (
    lanes.some(l =>
      ['local', 'no_vehicles', 'side_road', 'slow_road'].some(t =>
        l.includes(t),
      ),
    )
  ) {
    roadType = 'local';
  } else if (lanes.some(l => l.includes('tram'))) {
    roadType = 'tram';
  } else if (lanes.some(l => l.includes('train'))) {
    roadType = 'train';
  }
  return roadType;
}

export function getLaneSpeedClass(look: RoadLook): LaneSpeedClass {
  const lanes = look.lanesLeft.concat(look.lanesRight);
  if (lanes.some(l => l.includes('freeway'))) {
    return 'freeway';
  } else if (lanes.some(l => l.includes('motorway'))) {
    return 'motorway';
  } else if (lanes.some(l => l.includes('expressway'))) {
    return 'expressway';
  } else if (lanes.some(l => l.includes('divided'))) {
    return 'dividedRoad';
  } else if (lanes.some(l => l.includes('slow_road'))) {
    return 'slowRoad';
  }
  return 'localRoad';
}

/**
 * Road type of a road item. Template road looks (e.g. the universal "un 0-2"
 * looks used across Benelux and Scandinavia) only declare generic local lanes;
 * the item's lane variant (motorway, expressway, local_road…) is what tells a
 * motorway from a local road, so it wins when it names a known class.
 */
export function getItemRoadType(
  road: Pick<Road, 'rightLanesVariant' | 'leftLanesVariant'>,
  look: RoadLook,
): RoadType {
  const variants = [road.rightLanesVariant, road.leftLanesVariant].filter(
    (v): v is string => !!v,
  );
  if (variants.some(v => v.includes('motorway') || v.includes('freeway'))) {
    return 'freeway';
  }
  if (variants.some(v => v.includes('expressway') || v.includes('divided'))) {
    return 'divided';
  }
  if (variants.some(v => v.includes('local') || v.includes('slow'))) {
    return 'local';
  }
  return getRoadType(look);
}
