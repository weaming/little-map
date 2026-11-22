import { describe, expect, test } from 'bun:test';
import {
  computeAlignedTileSpec,
  formatArea,
  formatDistance,
  gcj02ToWgs84,
  isViewportInsidePolygon,
  lineLengthMeters,
  lngLatToWorldPx,
  polygonAreaSqMeters,
  wgs84ToGcj02,
  worldPxToLngLat,
} from './geo';

describe('geo utilities', () => {
  test('WGS-84 <-> GCJ-02 roundtrip accuracy in China', () => {
    const origLng = 116.3912757;
    const origLat = 39.906217;
    const [gLng, gLat] = wgs84ToGcj02(origLng, origLat);
    expect(Math.abs(gLng - origLng)).toBeGreaterThan(0.001);
    expect(Math.abs(gLat - origLat)).toBeGreaterThan(0.0005);

    const [backLng, backLat] = gcj02ToWgs84(gLng, gLat);
    expect(Math.abs(backLng - origLng)).toBeLessThan(1e-6);
    expect(Math.abs(backLat - origLat)).toBeLessThan(1e-6);
  });

  test('no GCJ-02 offset outside China', () => {
    const [lng, lat] = wgs84ToGcj02(-73.9857, 40.7484);
    expect(lng).toBe(-73.9857);
    expect(lat).toBe(40.7484);
  });

  test('distance and area calculation', () => {
    const dist = lineLengthMeters([
      [116.391, 39.907],
      [116.401, 39.907],
    ]);
    expect(dist).toBeGreaterThan(800);
    expect(dist).toBeLessThan(900);
    expect(formatDistance(dist)).toContain('m');
    expect(formatDistance(1520)).toBe('1.52 km');

    const area = polygonAreaSqMeters([
      [116.39, 39.9],
      [116.4, 39.9],
      [116.4, 39.91],
      [116.39, 39.91],
    ]);
    expect(area).toBeGreaterThan(900000);
    expect(area).toBeLessThan(1000000);
    expect(formatArea(area)).toContain('公顷');
  });

  test('aligned tile spec computes pixel shift in China and identity outside China', () => {
    // 北京 z=14 对应瓦片
    const [px, py] = lngLatToWorldPx(116.3974, 39.9093, 14);
    const [lngBack, latBack] = worldPxToLngLat(px, py, 14);
    expect(Math.abs(lngBack - 116.3974)).toBeLessThan(1e-6);
    expect(Math.abs(latBack - 39.9093)).toBeLessThan(1e-6);

    const specCN = computeAlignedTileSpec(14, Math.floor(px / 256), Math.floor(py / 256), 'wgs84', 'gcj02');
    expect(specCN.isIdentity).toBe(false);
    expect(specCN.sources.length).toBeGreaterThanOrEqual(2);
    expect(specCN.sources.length).toBeLessThanOrEqual(4);

    // 纽约 z=14 对应瓦片（海外无偏移）
    const [nyPx, nyPy] = lngLatToWorldPx(-73.9857, 40.7484, 14);
    const specNY = computeAlignedTileSpec(14, Math.floor(nyPx / 256), Math.floor(nyPy / 256), 'wgs84', 'gcj02');
    expect(specNY.isIdentity).toBe(true);
  });

  test('viewport inside polygon detection', () => {
    const bigSquare = [
      [116.0, 39.0],
      [117.0, 39.0],
      [117.0, 40.0],
      [116.0, 40.0],
      [116.0, 39.0],
    ];
    expect(
      isViewportInsidePolygon(
        [
          [116.2, 39.2],
          [116.8, 39.8],
        ],
        bigSquare,
      ),
    ).toBe(true);
    // 跨越边界
    expect(
      isViewportInsidePolygon(
        [
          [116.5, 39.5],
          [117.2, 39.8],
        ],
        bigSquare,
      ),
    ).toBe(false);
    // 完全包住多边形
    expect(
      isViewportInsidePolygon(
        [
          [115.0, 38.0],
          [118.0, 41.0],
        ],
        bigSquare,
      ),
    ).toBe(false);
  });
});
