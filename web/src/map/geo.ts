import type { BasemapId, GeoGeometry, MapFeature, OverlayId } from '../types/map';

const EARTH_RADIUS_M = 6371008.8;
const GCJ_AXIS = 6378245.0;
const GCJ_EE = 0.00669342162296594323;

export interface BasemapConfig {
  id: BasemapId;
  label: string;
  crs: 'wgs84' | 'gcj02';
  tiles: string[];
  attribution: string;
  maxzoom: number;
}

// 统一使用栅格瓦片接入高德、谷歌与 OSM，避免引入多套原生 SDK。
export const BASEMAPS: Record<BasemapId, BasemapConfig> = {
  'amap-vec': {
    id: 'amap-vec',
    label: '高德矢量',
    crs: 'gcj02',
    tiles: [
      'https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
      'https://webrd02.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
      'https://webrd03.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
      'https://webrd04.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    ],
    attribution: '© 高德地图',
    maxzoom: 18,
  },
  'amap-sat': {
    id: 'amap-sat',
    label: '高德卫星',
    crs: 'gcj02',
    tiles: [
      'https://webst01.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
      'https://webst02.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
      'https://webst03.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
      'https://webst04.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
    ],
    attribution: '© 高德卫星',
    maxzoom: 18,
  },
  'google-vec': {
    id: 'google-vec',
    label: 'Google 街道',
    crs: 'gcj02',
    tiles: [
      'https://mt0.google.com/vt/lyrs=m&hl=zh-CN&scale=2&x={x}&y={y}&z={z}',
      'https://mt1.google.com/vt/lyrs=m&hl=zh-CN&scale=2&x={x}&y={y}&z={z}',
      'https://mt2.google.com/vt/lyrs=m&hl=zh-CN&scale=2&x={x}&y={y}&z={z}',
      'https://mt3.google.com/vt/lyrs=m&hl=zh-CN&scale=2&x={x}&y={y}&z={z}',
    ],
    attribution: '© Google Maps',
    maxzoom: 20,
  },
  'google-sat': {
    id: 'google-sat',
    label: 'Google 卫星',
    crs: 'wgs84',
    tiles: [
      'https://mt0.google.com/vt/lyrs=s&hl=zh-CN&x={x}&y={y}&z={z}',
      'https://mt1.google.com/vt/lyrs=s&hl=zh-CN&x={x}&y={y}&z={z}',
      'https://mt2.google.com/vt/lyrs=s&hl=zh-CN&x={x}&y={y}&z={z}',
      'https://mt3.google.com/vt/lyrs=s&hl=zh-CN&x={x}&y={y}&z={z}',
    ],
    attribution: '© Google Satellite',
    maxzoom: 20,
  },
  osm: {
    id: 'osm',
    label: 'OpenStreetMap',
    crs: 'wgs84',
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    attribution: '© OpenStreetMap contributors',
    maxzoom: 19,
  },
};

export interface OverlayConfig {
  id: OverlayId;
  label: string;
  crs: 'wgs84' | 'gcj02';
  tiles: string[];
  maxzoom: number;
}

export const OVERLAYS: Record<OverlayId, OverlayConfig> = {
  none: {
    id: 'none',
    label: '无叠加层',
    crs: 'wgs84',
    tiles: [],
    maxzoom: 20,
  },
  'amap-label': {
    id: 'amap-label',
    label: '+ 高德标注（仅地名）',
    crs: 'gcj02',
    tiles: [
      'https://webst01.is.autonavi.com/appmaptile?style=8&ltype=4&x={x}&y={y}&z={z}',
      'https://webst02.is.autonavi.com/appmaptile?style=8&ltype=4&x={x}&y={y}&z={z}',
      'https://webst03.is.autonavi.com/appmaptile?style=8&ltype=4&x={x}&y={y}&z={z}',
      'https://webst04.is.autonavi.com/appmaptile?style=8&ltype=4&x={x}&y={y}&z={z}',
    ],
    maxzoom: 18,
  },
  'amap-road': {
    id: 'amap-road',
    label: '+ 高德路网（含路线）',
    crs: 'gcj02',
    tiles: [
      'https://webst01.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}',
      'https://webst02.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}',
      'https://webst03.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}',
      'https://webst04.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}',
    ],
    maxzoom: 18,
  },
  'google-road': {
    id: 'google-road',
    label: '+ Google 路网（2x 高清）',
    crs: 'gcj02',
    tiles: [
      'https://mt0.google.com/vt/lyrs=h&hl=zh-CN&scale=2&x={x}&y={y}&z={z}',
      'https://mt1.google.com/vt/lyrs=h&hl=zh-CN&scale=2&x={x}&y={y}&z={z}',
      'https://mt2.google.com/vt/lyrs=h&hl=zh-CN&scale=2&x={x}&y={y}&z={z}',
      'https://mt3.google.com/vt/lyrs=h&hl=zh-CN&scale=2&x={x}&y={y}&z={z}',
    ],
    maxzoom: 20,
  },
};

function isOutOfChina(lng: number, lat: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  return ret;
}

function gcjDelta(lng: number, lat: number): [number, number] {
  const dLatRaw = transformLat(lng - 105.0, lat - 35.0);
  const dLngRaw = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  const dLat = (dLatRaw * 180.0) / (((GCJ_AXIS * (1 - GCJ_EE)) / (magic * sqrtMagic)) * Math.PI);
  const dLng = (dLngRaw * 180.0) / ((GCJ_AXIS / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return [dLng, dLat];
}

export function wgs84ToGcj02(lng: number, lat: number): [number, number] {
  if (isOutOfChina(lng, lat)) return [lng, lat];
  const [dLng, dLat] = gcjDelta(lng, lat);
  return [lng + dLng, lat + dLat];
}

export function gcj02ToWgs84(lng: number, lat: number): [number, number] {
  if (isOutOfChina(lng, lat)) return [lng, lat];
  let wLng = lng;
  let wLat = lat;
  for (let i = 0; i < 5; i++) {
    const [gLng, gLat] = wgs84ToGcj02(wLng, wLat);
    wLng += lng - gLng;
    wLat += lat - gLat;
  }
  return [wLng, wLat];
}

export function wgs84ToDisplay(lng: number, lat: number, basemap: BasemapId): [number, number] {
  return BASEMAPS[basemap]?.crs === 'gcj02' ? wgs84ToGcj02(lng, lat) : [lng, lat];
}

export function displayToWgs84(lng: number, lat: number, basemap: BasemapId): [number, number] {
  return BASEMAPS[basemap]?.crs === 'gcj02' ? gcj02ToWgs84(lng, lat) : [lng, lat];
}

export function geometryToDisplay(geom: GeoGeometry, basemap: BasemapId): GeoGeometry {
  if (BASEMAPS[basemap]?.crs !== 'gcj02') return geom;

  if (geom.type === 'Point') {
    const [lng, lat] = geom.coordinates as number[];
    return { type: 'Point', coordinates: wgs84ToGcj02(lng, lat) };
  }
  if (geom.type === 'LineString') {
    const coords = geom.coordinates as number[][];
    return {
      type: 'LineString',
      coordinates: coords.map(([lng, lat]) => wgs84ToGcj02(lng, lat)),
    };
  }
  const rings = geom.coordinates as number[][][];
  return {
    type: 'Polygon',
    coordinates: rings.map((ring) => ring.map(([lng, lat]) => wgs84ToGcj02(lng, lat))),
  };
}

export function haversineMeters(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function lineLengthMeters(coords: number[][]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversineMeters(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  }
  return total;
}

export function polygonAreaSqMeters(ring: number[][]): number {
  if (ring.length < 3) return 0;
  const closed =
    ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring
      : [...ring, ring[0]];
  const rad = Math.PI / 180;
  let area = 0;
  for (let i = 0; i < closed.length - 1; i++) {
    const p1 = closed[i];
    const p2 = closed[i + 1];
    area += (p2[0] - p1[0]) * rad * (2 + Math.sin(p1[1] * rad) + Math.sin(p2[1] * rad));
  }
  return Math.abs((area * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
}

export function formatDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(2)} km`;
  return `${Math.round(meters)} m`;
}

export function formatArea(sqMeters: number): string {
  if (sqMeters >= 1_000_000) return `${(sqMeters / 1_000_000).toFixed(2)} km²`;
  if (sqMeters >= 10_000) return `${(sqMeters / 10_000).toFixed(2)} 公顷`;
  return `${Math.round(sqMeters)} m²`;
}

export function geometryCenter(geom: GeoGeometry): [number, number] {
  if (geom.type === 'Point') {
    const [lng, lat] = geom.coordinates as number[];
    return [lng, lat];
  }
  const pts =
    geom.type === 'LineString'
      ? (geom.coordinates as number[][])
      : ((geom.coordinates as number[][][])[0] ?? []);
  if (pts.length === 0) return [116.3974, 39.9093];
  const sum = pts.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
  return [sum[0] / pts.length, sum[1] / pts.length];
}

export type WgsBounds = [[number, number], [number, number]];

export function geometryBounds(geom: GeoGeometry): WgsBounds | null {
  if (geom.type === 'Point') return null;
  const pts =
    geom.type === 'LineString'
      ? (geom.coordinates as number[][])
      : ((geom.coordinates as number[][][])[0] ?? []);
  if (pts.length === 0) return null;

  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of pts) {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  }
  if (!Number.isFinite(minLng) || !Number.isFinite(minLat)) return null;
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}

// 计算所有可见要素的汇总视野（单点返回中心，多点/线/面返回外接包围盒）。
export function featuresViewport(
  features: Pick<MapFeature, 'visible' | 'geometry'>[],
): { center: [number, number]; bounds?: WgsBounds } | null {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  let count = 0;

  const pushPt = (lng: number, lat: number) => {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
    count++;
  };

  for (const f of features) {
    if (!f.visible) continue;
    if (f.geometry.type === 'Point') {
      const [lng, lat] = f.geometry.coordinates as number[];
      pushPt(lng, lat);
    } else if (f.geometry.type === 'LineString') {
      for (const [lng, lat] of f.geometry.coordinates as number[][]) {
        pushPt(lng, lat);
      }
    } else if (f.geometry.type === 'Polygon') {
      const ring = (f.geometry.coordinates as number[][][])[0] ?? [];
      for (const [lng, lat] of ring) {
        pushPt(lng, lat);
      }
    }
  }

  if (count === 0 || !Number.isFinite(minLng)) return null;
  const center: [number, number] = [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
  if (Math.abs(maxLng - minLng) < 1e-6 && Math.abs(maxLat - minLat) < 1e-6) {
    return { center };
  }
  return {
    center,
    bounds: [
      [minLng, minLat],
      [maxLng, maxLat],
    ],
  };
}

// 统计当前地图同几何类型标注中出现次数最多的颜色；无同类时回退 fallback。
export function pickDominantColor(
  features: Pick<MapFeature, 'color' | 'geometry'>[],
  geomType: GeoGeometry['type'],
  fallback = '#2563eb',
): string {
  const counts = new Map<string, number>();
  let bestColor = fallback;
  let bestCount = 0;

  for (const f of features) {
    if (f.geometry.type !== geomType) continue;
    const c = (f.color || '').trim();
    if (!c) continue;
    const next = (counts.get(c) ?? 0) + 1;
    counts.set(c, next);
    if (next > bestCount) {
      bestCount = next;
      bestColor = c;
    }
  }
  return bestColor;
}

// 射线法判断点是否在多边形环内部。
export function isPointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// 判断当前视口矩形（WGS-84）是否完全落入多边形内部。
export function isViewportInsidePolygon(viewport: WgsBounds | null, ring: number[][]): boolean {
  if (!viewport || ring.length < 3) return false;
  const [[minLng, minLat], [maxLng, maxLat]] = viewport;

  // 若多边形有任意顶点落在视口内，说明视口可见边界，并非完全在内部
  for (const [lng, lat] of ring) {
    if (lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat) {
      return false;
    }
  }

  // 视口四角与中心点全部在多边形内
  const corners: [number, number][] = [
    [minLng, minLat],
    [maxLng, minLat],
    [maxLng, maxLat],
    [minLng, maxLat],
    [(minLng + maxLng) / 2, (minLat + maxLat) / 2],
  ];
  return corners.every(([lng, lat]) => isPointInRing(lng, lat, ring));
}

export function getCurrentPositionWgs84(timeoutMs = 3000): Promise<[number, number] | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve([pos.coords.longitude, pos.coords.latitude]),
      () => resolve(null),
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 60000 },
    );
  });
}

export interface AlignedTileSource {
  x: number;
  y: number;
  drawX: number;
  drawY: number;
}

export interface AlignedTileSpec {
  isIdentity: boolean;
  dx: number;
  dy: number;
  sources: AlignedTileSource[];
}

export function lngLatToWorldPx(lng: number, lat: number, z: number): [number, number] {
  const scale = 256 * Math.pow(2, z);
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const sinLat = Math.sin((clampedLat * Math.PI) / 180);
  const x = ((lng + 180) / 360) * scale;
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
  return [x, y];
}

export function worldPxToLngLat(px: number, py: number, z: number): [number, number] {
  const scale = 256 * Math.pow(2, z);
  const lng = (px / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * py) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return [lng, lat];
}

// 计算跨 CRS 叠加瓦片的源瓦片索引与 Canvas 绘制偏移量。
export function computeAlignedTileSpec(
  z: number,
  x: number,
  y: number,
  targetCrs: 'wgs84' | 'gcj02',
  sourceCrs: 'wgs84' | 'gcj02',
): AlignedTileSpec {
  if (targetCrs === sourceCrs) {
    return { isIdentity: true, dx: 0, dy: 0, sources: [{ x, y, drawX: 0, drawY: 0 }] };
  }

  const cx = (x + 0.5) * 256;
  const cy = (y + 0.5) * 256;
  const [tLng, tLat] = worldPxToLngLat(cx, cy, z);
  const [sLng, sLat] =
    targetCrs === 'wgs84' && sourceCrs === 'gcj02' ? wgs84ToGcj02(tLng, tLat) : gcj02ToWgs84(tLng, tLat);

  const [sx, sy] = lngLatToWorldPx(sLng, sLat, z);
  const dx = sx - cx;
  const dy = sy - cy;

  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
    return { isIdentity: true, dx: 0, dy: 0, sources: [{ x, y, drawX: 0, drawY: 0 }] };
  }

  const maxTile = Math.pow(2, z);
  const srcLeft = x * 256 + dx;
  const srcTop = y * 256 + dy;
  const txMin = Math.floor(srcLeft / 256);
  const txMax = Math.floor((srcLeft + 255.999) / 256);
  const tyMin = Math.floor(srcTop / 256);
  const tyMax = Math.floor((srcTop + 255.999) / 256);

  const sources: AlignedTileSource[] = [];
  for (let ty = tyMin; ty <= tyMax; ty++) {
    if (ty < 0 || ty >= maxTile) continue;
    for (let tx = txMin; tx <= txMax; tx++) {
      const wrappedX = ((tx % maxTile) + maxTile) % maxTile;
      sources.push({
        x: wrappedX,
        y: ty,
        drawX: Math.round(tx * 256 - srcLeft),
        drawY: Math.round(ty * 256 - srcTop),
      });
    }
  }
  return { isIdentity: false, dx, dy, sources };
}
