// loaders.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {fromFile} from 'geotiff';

/**
 * Sign applied to the raw grid value to yield the geoid undulation N (metres) that
 * must be ADDED to an orthometric/gravity-related height to obtain an ellipsoidal
 * height (h = H + N). PROJ "geographic3D→gravityRelatedHeight" grids such as
 * `de_bkg_gcg2016.tif` store N positive-up (~+46 m over Germany), so the default is
 * +1. Validated at build time against the EGM2008 undulation for NRW (~+45.6 m);
 * flip to -1 if a grid uses the opposite (ellipsoidal-minus-orthometric) sign.
 */
const N_SIGN = 1;

/**
 * Geoid-height lookup backed by a PROJ-style GeoTIFF grid (e.g. the German
 * quasigeoid GCG2016, `de_bkg_gcg2016.tif`). Exposes the same `getHeight(lat, lon)`
 * interface as the PGM-based `GeoidHeightModel` used for EGM* grids, so it is a
 * drop-in replacement for the tile-converter's vertical correction and lets us use
 * a survey-grade national geoid instead of the global EGM models.
 */
export class GeoTiffGeoidModel {
  private readonly data: Float32Array;
  private readonly width: number;
  private readonly height: number;
  private readonly west: number;
  private readonly east: number;
  private readonly north: number;
  private readonly south: number;
  /**
   * Half-pixel offset applied when converting a lon/lat to a fractional grid
   * index. Depends on the file's raster convention (GTRasterTypeGeoKey):
   * - PixelIsArea (2, GDAL default): the tiepoint/bounding box is the OUTER cell
   *   corner and samples sit at cell centres, so index = frac*size - 0.5.
   * - PixelIsPoint (1): the tiepoint is the sample node itself, so index = frac*size.
   * Getting this wrong shifts the whole geoid by half a cell (~0.5-0.7 km here).
   */
  private readonly sampleOffset: number;

  private constructor(init: {
    data: Float32Array;
    width: number;
    height: number;
    west: number;
    east: number;
    north: number;
    south: number;
    sampleOffset: number;
  }) {
    this.data = init.data;
    this.width = init.width;
    this.height = init.height;
    this.west = init.west;
    this.east = init.east;
    this.north = init.north;
    this.south = init.south;
    this.sampleOffset = init.sampleOffset;
  }

  /**
   * Load a single-band geoid grid from a GeoTIFF file.
   * @param path - path to the .tif grid
   */
  static async fromFile(path: string): Promise<GeoTiffGeoidModel> {
    const tiff = await fromFile(path);
    const image = await tiff.getImage();
    const [west, south, east, north] = image.getBoundingBox();
    const [band] = await image.readRasters();
    // GTRasterTypeGeoKey: 1 = RasterPixelIsPoint, 2 = RasterPixelIsArea (default).
    const rasterType = (image.getGeoKeys() as {GTRasterTypeGeoKey?: number})?.GTRasterTypeGeoKey;
    const sampleOffset = rasterType === 1 ? 0 : -0.5;
    return new GeoTiffGeoidModel({
      data: band as Float32Array,
      width: image.getWidth(),
      height: image.getHeight(),
      west,
      east,
      north,
      south,
      sampleOffset
    });
  }

  /**
   * Bilinearly interpolated geoid undulation N (metres) to ADD to an orthometric
   * height. Sampling convention (cell-centre vs node) follows the grid's
   * GTRasterTypeGeoKey; coordinates outside the grid clamp to the edge.
   * @param lat - latitude in degrees
   * @param lon - longitude in degrees
   */
  getHeight(lat: number, lon: number): number {
    const {width, height, west, east, north, south, data, sampleOffset} = this;
    // Fractional pixel indices; row 0 is the north edge.
    let fx = ((lon - west) / (east - west)) * width + sampleOffset;
    let fy = ((north - lat) / (north - south)) * height + sampleOffset;
    fx = Math.min(Math.max(fx, 0), width - 1);
    fy = Math.min(Math.max(fy, 0), height - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, width - 1);
    const y1 = Math.min(y0 + 1, height - 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const v00 = data[y0 * width + x0];
    const v10 = data[y0 * width + x1];
    const v01 = data[y1 * width + x0];
    const v11 = data[y1 * width + x1];
    const top = v00 + (v10 - v00) * tx;
    const bottom = v01 + (v11 - v01) * tx;
    return N_SIGN * (top + (bottom - top) * ty);
  }
}
