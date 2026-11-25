import type {
  BasemapId,
  BeikeCluster,
  BeikeHouse,
  BeikeLiquidity,
  GeoGeometry,
  MapFeature,
  OverlayId,
  PlaceResult,
  RouteMode,
} from '../types/map';

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
  'baidu-sat': {
    id: 'baidu-sat',
    label: '百度卫星',
    crs: 'wgs84',
    tiles: [],
    attribution: '© 百度卫星',
    maxzoom: 18,
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
  'baidu-vec': {
    id: 'baidu-vec',
    label: '百度矢量（高清）',
    crs: 'wgs84',
    tiles: [],
    attribution: '© 百度地图',
    maxzoom: 18,
  },
  'google-vec': {
    id: 'google-vec',
    label: 'Google 街道（高清）',
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
  crs: 'wgs84' | 'gcj02' | 'bd09';
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
  'baidu-road': {
    id: 'baidu-road',
    label: '+ 百度标注（高清）',
    crs: 'bd09',
    tiles: [],
    maxzoom: 18,
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
    label: '+ Google 路网（高清）',
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

// 计算全部搜索结果的汇总视野（包含点坐标与行政区划边界，单点返回中心，多点或含边界返回包围盒）。
export function placesViewport(
  places: Pick<PlaceResult, 'lng' | 'lat' | 'boundary'>[],
): { center: [number, number]; bounds?: WgsBounds } | null {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  let count = 0;

  const pushPt = (lng: number, lat: number) => {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
    count++;
  };

  for (const p of places) {
    pushPt(p.lng, p.lat);
    if (p.boundary) {
      const b = geometryBounds(p.boundary);
      if (b) {
        pushPt(b[0][0], b[0][1]);
        pushPt(b[1][0], b[1][1]);
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

// 按小区与坐标将贝壳房源聚合为地图气泡；支持按视口、多选商圈（OR 关系）与关键词/特征标签（AND 关系）实时过滤。
export function clusterBeikeHouses(
  houses: BeikeHouse[],
  viewport?: WgsBounds | null,
  keyword = '',
  bizcircles: string[] = [],
  nowMs = Date.now(),
): BeikeCluster[] {
  const terms = keyword
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const bizSet = bizcircles.length > 0 ? new Set(bizcircles) : null;

  const map = new Map<string, BeikeCluster>();
  for (const h of houses) {
    if (!Number.isFinite(h.lng) || !Number.isFinite(h.lat)) continue;
    if (viewport) {
      const [[minLng, minLat], [maxLng, maxLat]] = viewport;
      if (h.lng < minLng || h.lng > maxLng || h.lat < minLat || h.lat > maxLat) {
        continue;
      }
    }
    if (bizSet && !bizSet.has((h.bizcircle || '').trim())) {
      continue;
    }
    if (terms.length > 0) {
      const haystack = [
        h.resblock,
        h.bizcircle,
        h.district,
        h.subway_name,
        h.subway_desc,
        h.title,
        h.layout,
        h.orientation,
        h.floor_level ?? '',
        h.highlights ?? '',
        h.price_note ?? '',
        ...h.tags,
      ]
        .join(' ')
        .toLowerCase();
      if (!terms.every((t) => haystack.includes(t))) {
        continue;
      }
    }
    const name = (h.resblock || h.title || '未命名小区').trim();
    const key = `${name}@${h.lng.toFixed(4)},${h.lat.toFixed(4)}`;
    let cluster = map.get(key);
    if (!cluster) {
      cluster = {
        key,
        resblock: name,
        district: h.district,
        bizcircle: h.bizcircle,
        lng: h.lng,
        lat: h.lat,
        minPrice: h.price > 0 ? h.price : Infinity,
        maxPrice: h.price > 0 ? h.price : 0,
        medianListedDays: null,
        liquidity: 'unknown',
        houses: [],
      };
      map.set(key, cluster);
    }
    cluster.houses.push(h);
    if (h.price > 0) {
      if (h.price < cluster.minPrice) cluster.minPrice = h.price;
      if (h.price > cluster.maxPrice) cluster.maxPrice = h.price;
    }
  }

  const out = [...map.values()].map((c) => {
    c.houses.sort((a, b) => (a.price || Infinity) - (b.price || Infinity));
    if (!Number.isFinite(c.minPrice)) c.minPrice = 0;

    const daysList: number[] = [];
    for (const h of c.houses) {
      if (!h.listed_at) continue;
      const ts = Date.parse(`${h.listed_at}T00:00:00+08:00`);
      if (!Number.isFinite(ts)) continue;
      daysList.push(Math.max(0, Math.floor((nowMs - ts) / 86_400_000)));
    }
    if (daysList.length > 0) {
      daysList.sort((a, b) => a - b);
      const mid = Math.floor(daysList.length / 2);
      const median =
        daysList.length % 2 === 1 ? daysList[mid] : Math.round((daysList[mid - 1] + daysList[mid]) / 2);
      c.medianListedDays = median;
      c.liquidity = median <= 14 ? 'hot' : median <= 45 ? 'normal' : 'slow';
    }
    return c;
  });
  out.sort((a, b) => (a.minPrice || Infinity) - (b.minPrice || Infinity));
  return out;
}

// 按小区气泡流动性着色筛选（多选 OR 关系；空数组表示不限）。
export function filterBeikeClustersByLiquidity(
  clusters: BeikeCluster[],
  liquidities: BeikeLiquidity[],
): BeikeCluster[] {
  if (liquidities.length === 0) return clusters;
  const allowed = new Set(liquidities);
  return clusters.filter((c) => allowed.has(c.liquidity));
}

function escapeCSVCell(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n') || val.includes('\r')) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

// 将贝壳房源列表格式化为标准 CSV（不含房源 ID，适合直接粘贴给 AI；图片 URL 默认不带，开启时置于最后一列）。
export function formatBeikeHousesCSV(houses: BeikeHouse[], includePhotos = false): string {
  const headers = [
    '标题',
    '小区',
    '区县',
    '商圈',
    '租金',
    '租赁方式',
    '户型',
    '面积(㎡)',
    '朝向',
    '楼层',
    '地铁',
    '标签',
    '小区亮点',
    '价格变动',
    '上架日期',
    '可入住',
    '坐标(GCJ02)',
  ];
  if (includePhotos) {
    headers.push('图片URL');
  }

  const lines: string[] = [headers.join(',')];
  for (const h of houses) {
    const rentLabel = h.rent_type === 'whole' ? '整租' : h.rent_type === 'shared' ? '合租' : '其他';
    const priceStr = h.price_text ? `${h.price_text}${h.price_unit || '元/月'}` : '';
    const floorStr =
      h.floor_level && h.floor_total > 0
        ? `${h.floor_level}/${h.floor_total}层`
        : h.floor_level || (h.floor_total > 0 ? `共${h.floor_total}层` : '');
    const [gLng, gLat] = wgs84ToGcj02(h.lng, h.lat);
    const row = [
      h.title || '',
      h.resblock || '',
      h.district || '',
      h.bizcircle || '',
      priceStr,
      rentLabel,
      h.layout || '',
      h.area > 0 ? String(h.area) : '',
      h.orientation || '',
      floorStr,
      h.subway_desc || h.subway_name || '',
      h.tags.join('/'),
      h.highlights || '',
      h.price_note || '',
      h.listed_at || '',
      h.available_at || '',
      `${gLng.toFixed(6)},${gLat.toFixed(6)}`,
    ];
    if (includePhotos) {
      row.push(h.pic_url || h.pic_thumb_url || '');
    }
    lines.push(row.map(escapeCSVCell).join(','));
  }
  return lines.join('\n');
}

export interface LabelLayoutItem {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pinRadius: number;
  priority: number;
}

export interface LabelPlacement {
  pinOffset: [number, number];
  labelLeft: number; // 相对偏移后圆点中心的 left（px）
  labelTop: number; // 相对偏移后圆点中心的 top（px）
}

export function estimateLabelWidth(text: string, maxWidth = 160): number {
  let w = 16;
  for (const ch of text) {
    w += ch.charCodeAt(0) > 255 ? 12 : 7;
  }
  return Math.min(maxWidth, Math.max(32, w));
}

// 对屏幕空间中重合或过近的点标记与文字标签做防重叠错位排布。
export function computeLabelPlacements(
  items: LabelLayoutItem[],
  minPinDist = 22,
): Map<string, LabelPlacement> {
  const result = new Map<string, LabelPlacement>();
  if (items.length === 0) return result;

  const sorted = [...items].sort((a, b) => a.priority - b.priority);
  const placedPins: Array<{ x: number; y: number; r: number }> = [];
  const placedBoxes: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];

  const pinOffsets = new Map<string, [number, number]>();
  const ringAngles = [0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (deg * Math.PI) / 180);

  // 1. 先对几乎重合的圆点做微型环状错位，确保每个点都可见可点击
  for (const item of sorted) {
    const collidesPin = (cx: number, cy: number) =>
      placedPins.some((p) => Math.hypot(cx - p.x, cy - p.y) < minPinDist);

    let ox = 0;
    let oy = 0;
    if (collidesPin(item.x, item.y)) {
      let found = false;
      for (let ring = 1; ring <= 4 && !found; ring++) {
        const radius = minPinDist * ring;
        for (const angle of ringAngles) {
          const tx = Math.round(Math.cos(angle) * radius);
          const ty = Math.round(Math.sin(angle) * radius);
          if (!collidesPin(item.x + tx, item.y + ty)) {
            ox = tx;
            oy = ty;
            found = true;
            break;
          }
        }
      }
      if (!found) {
        const idx = placedPins.length;
        const angle = (idx * 137.5 * Math.PI) / 180;
        ox = Math.round(Math.cos(angle) * minPinDist * 2.2);
        oy = Math.round(Math.sin(angle) * minPinDist * 2.2);
      }
    }
    pinOffsets.set(item.id, [ox, oy]);
    placedPins.push({ x: item.x + ox, y: item.y + oy, r: item.pinRadius });
  }

  const boxOverlapArea = (
    a: { x1: number; y1: number; x2: number; y2: number },
    b: { x1: number; y1: number; x2: number; y2: number },
  ): number => {
    const dx = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
    const dy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
    return dx > 0 && dy > 0 ? dx * dy : 0;
  };

  // 2. 为每个标签选择不重叠的方位（上 / 右 / 左 / 下 / 四角 / 外扩层）
  const pad = 3;
  for (let i = 0; i < sorted.length; i++) {
    const item = sorted[i];
    const [ox, oy] = pinOffsets.get(item.id) ?? [0, 0];
    const px = item.x + ox;
    const py = item.y + oy;
    const w = item.width;
    const h = item.height;
    const gap = item.pinRadius + 5;

    const candidates: Array<[number, number]> = [
      [-w / 2, -gap - h], // 正上
      [gap, -h / 2], // 正右
      [-gap - w, -h / 2], // 正左
      [-w / 2, gap], // 正下
      [gap, -gap - h], // 右上
      [-gap - w, -gap - h], // 左上
      [gap, gap], // 右下
      [-gap - w, gap], // 左下
      [-w / 2, -gap - h * 2 - 4], // 上二层
      [-w / 2, gap + h + 4], // 下二层
      [gap + 18, -h * 1.4], // 远右上
      [-gap - w - 18, h * 0.4], // 远左下
    ];

    let bestLeft = candidates[0][0];
    let bestTop = candidates[0][1];
    let bestPenalty = Infinity;

    for (const [left, top] of candidates) {
      const box = {
        x1: px + left - pad,
        y1: py + top - pad,
        x2: px + left + w + pad,
        y2: py + top + h + pad,
      };
      let penalty = 0;
      for (const existing of placedBoxes) {
        penalty += boxOverlapArea(box, existing);
      }
      for (let j = 0; j < placedPins.length; j++) {
        if (j === i) continue;
        const pin = placedPins[j];
        const pinBox = {
          x1: pin.x - pin.r - 2,
          y1: pin.y - pin.r - 2,
          x2: pin.x + pin.r + 2,
          y2: pin.y + pin.r + 2,
        };
        penalty += boxOverlapArea(box, pinBox) * 2;
      }
      if (penalty === 0) {
        bestLeft = left;
        bestTop = top;
        bestPenalty = 0;
        break;
      }
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        bestLeft = left;
        bestTop = top;
      }
    }

    placedBoxes.push({
      x1: px + bestLeft - pad,
      y1: py + bestTop - pad,
      x2: px + bestLeft + w + pad,
      y2: py + bestTop + h + pad,
    });
    result.set(item.id, {
      pinOffset: [ox, oy],
      labelLeft: Math.round(bestLeft),
      labelTop: Math.round(bestTop),
    });
  }

  return result;
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

// 计算点击点最接近的折线段，返回应插入新途经点的位置索引 (1 .. waypoints.length-1)。
export function findNearestSegmentInsertIndex(waypoints: [number, number][], pt: [number, number]): number {
  if (waypoints.length < 2) return waypoints.length;
  let bestIdx = waypoints.length - 1;
  let bestDistSq = Infinity;

  for (let i = 0; i < waypoints.length - 1; i++) {
    const [ax, ay] = waypoints[i];
    const [bx, by] = waypoints[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = 0;
    if (lenSq > 0) {
      t = Math.max(0, Math.min(1, ((pt[0] - ax) * dx + (pt[1] - ay) * dy) / lenSq));
    }
    const px = ax + t * dx;
    const py = ay + t * dy;
    const distSq = (pt[0] - px) * (pt[0] - px) + (pt[1] - py) * (pt[1] - py);
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestIdx = i + 1;
    }
  }
  return bestIdx;
}

// 原地替换折线的 [startIdx .. endIdx] 区间为新轨迹（自动去重衔接点），其余原始顶点 100% 保留。
export function spliceLineSegment(
  coords: [number, number][],
  startIdx: number,
  endIdx: number,
  replacement: [number, number][],
): [number, number][] {
  if (coords.length === 0 || startIdx < 0 || endIdx >= coords.length || startIdx > endIdx) {
    return coords;
  }
  const head = coords.slice(0, startIdx);
  const tail = coords.slice(endIdx + 1);
  const combined: [number, number][] = [...head];

  const pushDedup = (pt: [number, number]) => {
    const rounded: [number, number] = [Number(pt[0].toFixed(6)), Number(pt[1].toFixed(6))];
    const last = combined[combined.length - 1];
    if (last && last[0] === rounded[0] && last[1] === rounded[1]) return;
    combined.push(rounded);
  };

  for (const pt of replacement) pushDedup(pt);
  for (const pt of tail) pushDedup(pt);
  return combined;
}

// 在原折线上查找距离目标点最近的真实顶点索引与距离（米）。
export function findNearestVertexIndex(
  coords: [number, number][],
  pt: [number, number],
): { index: number; distMeters: number } {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = haversineMeters(coords[i][0], coords[i][1], pt[0], pt[1]);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return { index: bestIdx, distMeters: bestDist };
}

// 根据出行方式与必经点偏离原路的距离，自动计算建议的局部换路区间 [startIdx .. endIdx]。
export function computeDetourWindow(
  coords: [number, number][],
  viaPoints: [number, number][],
  mode: RouteMode,
): { startIdx: number; endIdx: number } {
  if (coords.length < 2 || viaPoints.length === 0) {
    return { startIdx: 0, endIdx: Math.max(0, coords.length - 1) };
  }

  let minNear = coords.length - 1;
  let maxNear = 0;
  let maxDist = 0;
  for (const vp of viaPoints) {
    const { index, distMeters } = findNearestVertexIndex(coords, vp);
    if (index < minNear) minNear = index;
    if (index > maxNear) maxNear = index;
    if (distMeters > maxDist) maxDist = distMeters;
  }

  const [factor, minR, maxR] =
    mode === 'walking' ? [2.5, 200, 3000] : mode === 'driving' ? [3.0, 1000, 25000] : [2.5, 400, 6000];
  const radius = Math.max(minR, Math.min(maxR, maxDist * factor));

  let startIdx = minNear;
  let accBack = 0;
  while (startIdx > 0 && accBack < radius) {
    accBack += haversineMeters(
      coords[startIdx][0],
      coords[startIdx][1],
      coords[startIdx - 1][0],
      coords[startIdx - 1][1],
    );
    startIdx--;
  }

  let endIdx = maxNear;
  let accFwd = 0;
  while (endIdx < coords.length - 1 && accFwd < radius) {
    accFwd += haversineMeters(
      coords[endIdx][0],
      coords[endIdx][1],
      coords[endIdx + 1][0],
      coords[endIdx + 1][1],
    );
    endIdx++;
  }

  if (startIdx === endIdx) {
    if (startIdx > 0) startIdx--;
    else if (endIdx < coords.length - 1) endIdx++;
  }
  return { startIdx, endIdx };
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

const BD_X_PI = (Math.PI * 3000.0) / 180.0;
const BD_LLBAND = [75, 60, 45, 30, 15, 0];
const BD_LL2MC: number[][] = [
  [-0.0015702102444, 111320.7020616939, 1704480524535203, -10338987376042340, 26112667856603880, -35149669176653700, 26595700718403920, -10725012454188240, 1800819912950474, 82.5],
  [0.0008277824516172526, 111320.7020463578, 647795574.6671607, -4082003173.641316, 10774905663.51142, -15171875531.51559, 12053065338.62167, -5124939663.577472, 913311935.9512032, 67.5],
  [0.00337398766765, 111320.7020202162, 4481351.045890365, -23393751.19931662, 79682215.47186455, -115964993.2797253, 97236711.15602145, -43661946.33752821, 8477230.501135234, 52.5],
  [0.00220636496208, 111320.7020209128, 51751.86112841131, 3796837.749470245, 992013.7397791013, -1221952.21711287, 1340652.697009075, -620943.6990984312, 144416.9293806241, 37.5],
  [-0.0003441963504368392, 111320.7020576856, 278.2353980772752, 2485758.690035394, 6070.750963243378, 54821.18345352118, 9540.606633304236, -2710.55326746645, 1405.483844121726, 22.5],
  [-0.0003218135878613132, 111320.7020701615, 0.00369383431289, 823725.6402795718, 0.46104986909093, 2351.343141331292, 1.58060784298199, 8.77738589078284, 0.37238884252424, 7.45],
];

// 将 GCJ-02 经纬度转换为百度 BD-09 经纬度。
export function gcj02ToBd09(lng: number, lat: number): [number, number] {
  const z = Math.hypot(lng, lat) + 0.00002 * Math.sin(lat * BD_X_PI);
  const theta = Math.atan2(lat, lng) + 0.000003 * Math.cos(lng * BD_X_PI);
  return [z * Math.cos(theta) + 0.0065, z * Math.sin(theta) + 0.006];
}

// 将百度 BD-09 经纬度反算回 GCJ-02 经纬度。
export function bd09ToGcj02(lng: number, lat: number): [number, number] {
  const x = lng - 0.0065;
  const y = lat - 0.006;
  const z = Math.hypot(x, y) - 0.00002 * Math.sin(y * BD_X_PI);
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * BD_X_PI);
  return [z * Math.cos(theta), z * Math.sin(theta)];
}

const BD_MCBAND = [12890594.86, 8362377.87, 5591021.0, 3481989.83, 1678043.12, 0];
const BD_MC2LL: number[][] = [
  [1.410526172116255e-8, 0.00000898305509648872, -1.9939833816331, 200.9824383106796, -187.2403703815547, 91.6087516669843, -23.38765649603339, 2.57121317296198, -0.03801003308653, 17337981.2],
  [-7.435856389565537e-9, 0.000008983055097726239, -0.78625201886289, 96.32687599759846, -1.85204757529826, -59.36935905485877, 47.40033549296737, -16.50741931063887, 2.28786674699375, 10260144.86],
  [-3.030883460898826e-8, 0.00000898305509983578, 0.30071316287616, 59.74293618442277, 7.357984074871, -25.38371002664745, 13.45380521110908, -3.29883767235584, 0.32710905363475, 6856817.37],
  [-1.981981304930552e-8, 0.000008983055099779535, 0.03278182852591, 40.31678527705744, 0.65659298677277, -4.44255534477492, 0.85341911805263, 0.12923347998204, -0.04625736007561, 4482777.06],
  [3.09191371068437e-9, 0.000008983055096812155, 0.00006995724062, 23.10934304144901, -0.00023663490511, -0.6321817810242, -0.00663494467273, 0.03430082397953, -0.00466043876332, 2555164.4],
  [2.890871144776878e-9, 0.000008983055095805407, -3.068298e-8, 7.47137025468032, -0.00000353937994, -0.02145144861037, -0.00001234426596, 0.00010322952773, -0.00000323890364, 826088.5],
];

// 将百度平面墨卡托（BD09MC）米制坐标反算为百度 BD-09 经纬度。
export function mercatorToBd09(mx: number, my: number): [number, number] {
  const absX = Math.abs(mx);
  const absY = Math.abs(my);

  let c = BD_MC2LL[BD_MC2LL.length - 1];
  for (let i = 0; i < BD_MCBAND.length; i++) {
    if (absY >= BD_MCBAND[i]) {
      c = BD_MC2LL[i];
      break;
    }
  }

  const lng = c[0] + c[1] * absX;
  const t = absY / c[9];
  const lat =
    c[2] +
    c[3] * t +
    c[4] * t * t +
    c[5] * t * t * t +
    c[6] * t * t * t * t +
    c[7] * t * t * t * t * t +
    c[8] * t * t * t * t * t * t;

  return [mx < 0 ? -lng : lng, my < 0 ? -lat : lat];
}

// 将百度 BD-09 经纬度转换为百度平面墨卡托（BD09MC）米制坐标。
export function bd09ToMercator(lng: number, lat: number): [number, number] {
  const clampedLng = ((lng + 180) % 360 + 360) % 360 - 180;
  const clampedLat = Math.max(-74, Math.min(74, lat));
  const absLat = Math.abs(clampedLat);

  let c = BD_LL2MC[BD_LL2MC.length - 1];
  for (let i = 0; i < BD_LLBAND.length; i++) {
    if (absLat >= BD_LLBAND[i]) {
      c = BD_LL2MC[i];
      break;
    }
  }

  const x = c[0] + c[1] * Math.abs(clampedLng);
  const t = absLat / c[9];
  const y =
    c[2] +
    c[3] * t +
    c[4] * t * t +
    c[5] * t * t * t +
    c[6] * t * t * t * t +
    c[7] * t * t * t * t * t +
    c[8] * t * t * t * t * t * t;

  return [clampedLng < 0 ? -x : x, clampedLat < 0 ? -y : y];
}

export interface BaiduTilePatch {
  bx: number;
  by: number;
  drawX: number;
  drawY: number;
  drawW: number;
  drawH: number;
}

export interface BaiduAlignedTileSpec {
  bz: number;
  patches: BaiduTilePatch[];
}

// 将标准 EPSG:3857 瓦片 (z, x, y) 精确映射到百度 BD09MC 瓦片网格，供 Canvas 像素级重投影绘制。
export function computeBaiduAlignedTileSpec(
  z: number,
  x: number,
  y: number,
  targetCrs: 'wgs84' | 'gcj02',
): BaiduAlignedTileSpec {
  const [westLng, northLat] = worldPxToLngLat(x * 256, y * 256, z);
  const [eastLng, southLat] = worldPxToLngLat((x + 1) * 256, (y + 1) * 256, z);

  const toBdMc = (lng: number, lat: number): [number, number] => {
    const [gLng, gLat] = targetCrs === 'wgs84' ? wgs84ToGcj02(lng, lat) : [lng, lat];
    const [bLng, bLat] = gcj02ToBd09(gLng, gLat);
    return bd09ToMercator(bLng, bLat);
  };

  const [mcMinX, mcMaxY] = toBdMc(westLng, northLat);
  const [mcMaxX, mcMinY] = toBdMc(eastLng, southLat);
  const spanX = mcMaxX - mcMinX;
  const spanY = mcMaxY - mcMinY;
  if (spanX <= 0 || spanY <= 0) {
    return { bz: Math.max(3, Math.min(19, z + 1)), patches: [] };
  }

  // 动态匹配与目标 3857 瓦片分辨率最接近的百度缩放级别（保持 1:1 清晰度）
  const idealBz = Math.round(Math.log2((256 * Math.pow(2, 18)) / spanX));
  const bz = Math.max(3, Math.min(19, idealBz));
  const tileSpan = 256 * Math.pow(2, 18 - bz);

  const bxMin = Math.floor(mcMinX / tileSpan);
  const bxMax = Math.floor((mcMaxX - 1e-6) / tileSpan);
  const byMin = Math.floor(mcMinY / tileSpan);
  const byMax = Math.floor((mcMaxY - 1e-6) / tileSpan);

  // 极端低缩放级别下限制单瓦片最大拼接数，避免过多请求
  if ((bxMax - bxMin + 1) * (byMax - byMin + 1) > 16) {
    return { bz, patches: [] };
  }

  const patches: BaiduTilePatch[] = [];
  for (let by = byMin; by <= byMax; by++) {
    for (let bx = bxMin; bx <= bxMax; bx++) {
      const tileLeft = bx * tileSpan;
      const tileTop = (by + 1) * tileSpan;
      patches.push({
        bx,
        by,
        drawX: ((tileLeft - mcMinX) / spanX) * 256,
        drawY: ((mcMaxY - tileTop) / spanY) * 256,
        drawW: (tileSpan / spanX) * 256,
        drawH: (tileSpan / spanY) * 256,
      });
    }
  }
  return { bz, patches };
}
