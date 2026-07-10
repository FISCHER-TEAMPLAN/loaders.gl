// loaders.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Proj4Projection} from '@math.gl/proj4';
// Canonical proj4 definition strings for the full EPSG registry (~5400 CRS), so any
// projected source CRS is supported without hand-maintaining definitions. Keyed
// 'EPSG:<code>' -> [name, proj4String]. `@math.gl/proj4` is a thin wrapper around
// proj4 and (like proj4 itself) only ships a handful of built-in CRS
// (4326/3857/WGS84/...); it does NOT bundle a registry, so every other EPSG code
// still needs its definition supplied here.
// @ts-expect-error no bundled types
import proj4List from 'proj4-list';

/**
 * A minimal horizontal reprojection from an I3S store's (projected) index/vertex
 * CRS to WGS84 geographic coordinates (EPSG:4326).
 *
 * I3S "global mode" stores use WGS84 (4326) or CGCS2000 (4490) and need no
 * reprojection. I3S "local mode" stores may use a projected CRS (e.g. EPSG:25832,
 * ETRS89 / UTM zone 32N), in which node bounding-volume centers and vertex
 * positions are expressed in projected meters rather than lng/lat. deck.gl /
 * 3D Tiles work in WGS84 ECEF, so those coordinates must be reprojected to
 * lng/lat before the cartographic -> cartesian step.
 */
export interface Projection {
  /** EPSG code of the source CRS. */
  wkid: number;
  /** Transform projected [x(easting), y(northing)] -> geographic [lon, lat] (degrees). */
  forward(coords: [number, number]): [number, number];
}

const WGS84 = '+proj=longlat +datum=WGS84 +no_defs';

/** WGS84 and CGCS2000 are I3S global-mode geographic CRS — no reprojection needed. */
const GEOGRAPHIC_WKIDS = new Set([4326, 4490]);

/**
 * Optional overrides for a source CRS proj4 definition, keyed by EPSG (wkid). The
 * registry (`proj4-list`) is authoritative for the vast majority of codes; put an
 * entry here only to deliberately deviate (e.g. a specific datum/epoch policy).
 *
 * Note on datum: for the ETRS89 / UTM zones (25831–25833) the registry definition
 * uses `+towgs84=0,0,0,0,0,0,0`, i.e. the ETRS89 realization is placed on the
 * GRS80≈WGS84 ellipsoid with no epoch shift — which matches the conversion plan's
 * default, so no override is needed for those.
 */
const PROJ4_DEF_OVERRIDES: Record<number, string> = {};

/**
 * Resolve a proj4 definition string for an EPSG code, preferring an explicit
 * override, then the canonical `proj4-list` registry.
 * @param wkid - EPSG code
 * @returns the proj4 definition string, or `undefined` if the code is unknown
 */
function resolveProj4Def(wkid: number): string | undefined {
  if (PROJ4_DEF_OVERRIDES[wkid]) {
    return PROJ4_DEF_OVERRIDES[wkid];
  }
  const entry = proj4List[`EPSG:${wkid}`];
  // proj4-list entries are [name, proj4String].
  return Array.isArray(entry) ? entry[1] : undefined;
}

/**
 * Build a {@link Projection} from an I3S store spatialReference. Returns `null`
 * for geographic (global-mode) stores, in which case callers keep their existing
 * WGS84 code path unchanged.
 * @param spatialReference - store.spatialReference from the I3S layer JSON
 * @throws if the source CRS is projected but has no known proj4 definition
 */
export function createProjection(spatialReference?: {
  wkid?: number;
  latestWkid?: number;
}): Projection | null {
  const wkid = spatialReference?.latestWkid ?? spatialReference?.wkid;
  if (!wkid || GEOGRAPHIC_WKIDS.has(wkid)) {
    return null;
  }
  const def = resolveProj4Def(wkid);
  if (!def) {
    throw new Error(
      `tile-converter: no proj4 definition found for source I3S CRS EPSG:${wkid}. ` +
        `Add an entry to PROJ4_DEF_OVERRIDES in helpers/projection.ts.`
    );
  }
  const projection = new Proj4Projection({from: def, to: WGS84});
  return {
    wkid,
    forward(coords: [number, number]): [number, number] {
      const [lon, lat] = projection.project(coords);
      return [lon, lat];
    }
  };
}
