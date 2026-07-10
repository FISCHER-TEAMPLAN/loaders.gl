import {Vector3, Matrix4, Quaternion} from '@math.gl/core';
import {Ellipsoid} from '@math.gl/geospatial';
import {OrientedBoundingBox} from '@math.gl/culling';
// @ts-expect-error
import {GeoidHeightModel} from '@loaders.gl/tile-converter/lib/geoid-height-model';
import type {Projection} from './projection';

/**
 * Reproject a point from a projected source CRS to WGS84 ECEF, adding the geoid
 * undulation so a gravity-related (orthometric) height becomes ellipsoidal.
 * @param coord - source [easting, northing, gravity-related height]
 * @param projection - source-CRS -> WGS84 reprojection
 * @param geoidHeightModel - geoid model (undulation lookup); may return 0 to disable
 * @param result - output ECEF vector
 */
function reprojectToEcef(
  coord: number[],
  projection: Projection,
  geoidHeightModel: GeoidHeightModel,
  result: Vector3
): Vector3 {
  const [lon, lat] = projection.forward([coord[0], coord[1]]);
  const height = coord[2] + geoidHeightModel.getHeight(lat, lon);
  return Ellipsoid.WGS84.cartographicToCartesian([lon, lat, height], result);
}

const CORNER_SIGNS: [number, number, number][] = [
  [-1, -1, -1],
  [-1, -1, 1],
  [-1, 1, -1],
  [-1, 1, 1],
  [1, -1, -1],
  [1, -1, 1],
  [1, 1, -1],
  [1, 1, 1]
];

/**
 * Build a 3D Tiles oriented box (12 numbers) for a local-mode (projected CRS) I3S
 * node. Reprojecting only the OBB center and reusing the projected half-axes /
 * quaternion (as the WGS84 path does) would leave the box oriented to the source
 * grid rather than to ECEF; over a multi-km tile that misaligns the cull box by
 * >100 m (the ~1.9° meridian convergence alone) and silently drops tiles. Instead
 * we reproject the 8 source-OBB corners to ECEF and fit a tight East-North-Up
 * aligned box at the reprojected center, so it tracks true north and absorbs the
 * meridian convergence exactly.
 */
function buildEnuOrientedBox(
  i3SObb: {center: number[]; halfSize: number[]; quaternion: number[]},
  projection: Projection,
  geoidHeightModel: GeoidHeightModel
): number[] {
  const {center, halfSize, quaternion} = i3SObb;
  const rotation = new Matrix4().fromQuaternion(new Quaternion(quaternion));
  const ecefCenter = reprojectToEcef(center, projection, geoidHeightModel, new Vector3());

  const enu = Ellipsoid.WGS84.eastNorthUpToFixedFrame(ecefCenter, new Matrix4());
  const east = new Vector3(enu[0], enu[1], enu[2]);
  const north = new Vector3(enu[4], enu[5], enu[6]);
  const up = new Vector3(enu[8], enu[9], enu[10]);

  const axes = [east, north, up];
  const half = [0, 0, 0];
  const offset = new Vector3();
  const cornerCoord = [0, 0, 0];
  const corner = new Vector3();
  const delta = new Vector3();
  for (const [sx, sy, sz] of CORNER_SIGNS) {
    // Corner offset in the projected CRS, oriented by the source OBB quaternion.
    offset.set(sx * halfSize[0], sy * halfSize[1], sz * halfSize[2]);
    rotation.transformAsVector(offset, offset);
    cornerCoord[0] = center[0] + offset[0];
    cornerCoord[1] = center[1] + offset[1];
    cornerCoord[2] = center[2] + offset[2];
    reprojectToEcef(cornerCoord, projection, geoidHeightModel, corner);
    delta.copy(corner).subtract(ecefCenter);
    for (let a = 0; a < 3; a++) {
      half[a] = Math.max(half[a], Math.abs(delta.dot(axes[a])));
    }
  }

  return [
    ecefCenter[0],
    ecefCenter[1],
    ecefCenter[2],
    east[0] * half[0],
    east[1] * half[0],
    east[2] * half[0],
    north[0] * half[1],
    north[1] * half[1],
    north[2] * half[1],
    up[0] * half[2],
    up[1] * half[2],
    up[2] * half[2]
  ];
}

/**
 * Convert quaternion-based OBB to half-axes-based OBB
 * @param i3SObb quaternion based OBB
 * @param geoidHeightModel the Earth Gravity Model instance
 * @param projection - optional reprojection for local-mode (projected CRS) I3S;
 *   when set, the OBB is rebuilt in ECEF from the reprojected corners. When null
 *   (global-mode WGS84 stores) the behavior is unchanged.
 * @returns number[12] 3DTiles OBB https://github.com/CesiumGS/3d-tiles/tree/master/specification#box
 */
export function i3sObbTo3dTilesObb(
  i3SObb: {
    center: number[];
    halfSize: number[];
    quaternion: number[];
  },
  geoidHeightModel: GeoidHeightModel,
  projection: Projection | null = null
): number[] {
  if (projection) {
    return buildEnuOrientedBox(i3SObb, projection, geoidHeightModel);
  }
  // Global-mode (WGS84 / CGCS2000) stores: center is [lng, lat, height] and the
  // half-sizes/quaternion are already in a geographic frame — unchanged upstream path.
  const tiles3DCenter = [
    i3SObb.center[0],
    i3SObb.center[1],
    i3SObb.center[2] + geoidHeightModel.getHeight(i3SObb.center[1], i3SObb.center[0])
  ];
  const cartesianCenter = Ellipsoid.WGS84.cartographicToCartesian(tiles3DCenter, new Vector3());
  const tiles3DObb = new OrientedBoundingBox().fromCenterHalfSizeQuaternion(
    cartesianCenter,
    i3SObb.halfSize,
    i3SObb.quaternion
  );
  return [...tiles3DObb.center, ...tiles3DObb.halfAxes.toArray()];
}
