import { describe, expect, test } from 'bun:test';
import {
  bd09ToGcj02,
  bd09ToMercator,
  clusterBeikeHouses,
  computeAlignedTileSpec,
  computeBaiduAlignedTileSpec,
  computeDetourWindow,
  computeLabelPlacements,
  featuresViewport,
  filterBeikeClustersByLiquidity,
  formatArea,
  formatBeikeHousesCSV,
  formatDistance,
  gcj02ToBd09,
  gcj02ToWgs84,
  mercatorToBd09,
  isViewportInsidePolygon,
  lineLengthMeters,
  lngLatToWorldPx,
  pickDominantColor,
  placesViewport,
  polygonAreaSqMeters,
  spliceLineSegment,
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

  test('BD-09 Mercator projection and Baidu aligned tile mapping', () => {
    const [gLng, gLat] = wgs84ToGcj02(116.3974, 39.9093);
    const [bLng, bLat] = gcj02ToBd09(gLng, gLat);
    expect(bLng).toBeGreaterThan(116.405);
    expect(bLat).toBeGreaterThan(39.914);

    const [mx, my] = bd09ToMercator(bLng, bLat);
    expect(mx).toBeGreaterThan(12955000);
    expect(mx).toBeLessThan(12965000);
    expect(my).toBeGreaterThan(4820000);
    expect(my).toBeLessThan(4835000);

    // 反向 BD09MC -> BD-09 -> GCJ-02 往返精度应 < 1e-4 度
    const [bLngBack, bLatBack] = mercatorToBd09(mx, my);
    expect(Math.abs(bLngBack - bLng)).toBeLessThan(1e-4);
    expect(Math.abs(bLatBack - bLat)).toBeLessThan(1e-4);
    const [gLngBack, gLatBack] = bd09ToGcj02(bLngBack, bLatBack);
    expect(Math.abs(gLngBack - gLng)).toBeLessThan(1e-4);
    expect(Math.abs(gLatBack - gLat)).toBeLessThan(1e-4);

    const [px, py] = lngLatToWorldPx(116.3974, 39.9093, 12);
    const bdSpec = computeBaiduAlignedTileSpec(12, Math.floor(px / 256), Math.floor(py / 256), 'wgs84');
    expect(bdSpec.bz).toBeGreaterThanOrEqual(12);
    expect(bdSpec.bz).toBeLessThanOrEqual(14);
    expect(bdSpec.patches.length).toBeGreaterThanOrEqual(1);
    expect(bdSpec.patches.length).toBeLessThanOrEqual(9);
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

  test('featuresViewport ignores hidden features and fits visible ones', () => {
    const vp = featuresViewport([
      { visible: false, geometry: { type: 'Point', coordinates: [100, 20] } },
      { visible: true, geometry: { type: 'Point', coordinates: [116.3, 39.9] } },
      { visible: true, geometry: { type: 'Point', coordinates: [116.5, 40.1] } },
    ]);
    expect(vp).not.toBeNull();
    expect(vp?.bounds).toEqual([
      [116.3, 39.9],
      [116.5, 40.1],
    ]);

    const single = featuresViewport([
      { visible: true, geometry: { type: 'Point', coordinates: [116.3, 39.9] } },
    ]);
    expect(single?.center).toEqual([116.3, 39.9]);
    expect(single?.bounds).toBeUndefined();
  });

  test('placesViewport fits all search results including boundaries', () => {
    expect(placesViewport([])).toBeNull();

    const single = placesViewport([{ lng: 116.4, lat: 39.9 }]);
    expect(single?.center).toEqual([116.4, 39.9]);
    expect(single?.bounds).toBeUndefined();

    const multi = placesViewport([
      { lng: 116.35, lat: 39.88 },
      { lng: 116.45, lat: 39.95 },
    ]);
    expect(multi?.bounds).toEqual([
      [116.35, 39.88],
      [116.45, 39.95],
    ]);

    const withBoundary = placesViewport([
      {
        lng: 116.4,
        lat: 39.9,
        boundary: {
          type: 'Polygon',
          coordinates: [
            [
              [116.3, 39.8],
              [116.5, 39.8],
              [116.5, 40.0],
              [116.3, 40.0],
              [116.3, 39.8],
            ],
          ],
        },
      },
    ]);
    expect(withBoundary?.bounds).toEqual([
      [116.3, 39.8],
      [116.5, 40.0],
    ]);
  });

  test('pickDominantColor picks most frequent color within same geometry type', () => {
    const sample = [
      { color: '#dc2626', geometry: { type: 'Point' as const, coordinates: [116.3, 39.9] } },
      { color: '#16a34a', geometry: { type: 'Point' as const, coordinates: [116.4, 39.9] } },
      { color: '#dc2626', geometry: { type: 'Point' as const, coordinates: [116.5, 39.9] } },
      { color: '#7c3aed', geometry: { type: 'LineString' as const, coordinates: [[116.3, 39.9], [116.4, 40.0]] } },
    ];
    expect(pickDominantColor(sample, 'Point', '#2563eb')).toBe('#dc2626');
    expect(pickDominantColor(sample, 'LineString', '#2563eb')).toBe('#7c3aed');
    expect(pickDominantColor(sample, 'Polygon', '#2563eb')).toBe('#2563eb');
  });

  test('spliceLineSegment and computeDetourWindow adapt radius by route mode', () => {
    const orig: [number, number][] = Array.from({ length: 50 }, (_, i) => [116.0 + i * 0.002, 39.9]);
    const via: [number, number] = [116.05, 39.905]; // 中段偏离约 550m

    const walkWin = computeDetourWindow(orig, [via], 'walking');
    const driveWin = computeDetourWindow(orig, [via], 'driving');
    expect(walkWin.startIdx).toBeLessThan(walkWin.endIdx);
    // 驾车窗口应比徒步窗口更宽
    expect(driveWin.endIdx - driveWin.startIdx).toBeGreaterThanOrEqual(walkWin.endIdx - walkWin.startIdx);

    const replaced = spliceLineSegment(orig, 10, 12, [
      orig[10],
      [116.022, 39.905],
      orig[12],
    ]);
    expect(replaced[0]).toEqual(orig[0]);
    expect(replaced[replaced.length - 1]).toEqual(orig[orig.length - 1]);
  });

  test('computeLabelPlacements separates overlapping pins and labels at same coordinate', () => {
    const placements = computeLabelPlacements([
      { id: 'a', x: 200, y: 200, width: 80, height: 22, pinRadius: 10, priority: 0 },
      { id: 'b', x: 200, y: 200, width: 80, height: 22, pinRadius: 10, priority: 1 },
      { id: 'c', x: 200, y: 200, width: 80, height: 22, pinRadius: 10, priority: 2 },
    ]);

    const pa = placements.get('a')!;
    const pb = placements.get('b')!;
    const pc = placements.get('c')!;

    // 高优先级保持在原位，其余圆点错开 >= 22px
    expect(pa.pinOffset).toEqual([0, 0]);
    expect(Math.hypot(pb.pinOffset[0] - pa.pinOffset[0], pb.pinOffset[1] - pa.pinOffset[1])).toBeGreaterThanOrEqual(22);
    expect(Math.hypot(pc.pinOffset[0] - pa.pinOffset[0], pc.pinOffset[1] - pa.pinOffset[1])).toBeGreaterThanOrEqual(22);
    expect(Math.hypot(pc.pinOffset[0] - pb.pinOffset[0], pc.pinOffset[1] - pb.pinOffset[1])).toBeGreaterThanOrEqual(22);

    // 三个标签矩形两两无重叠
    const boxes = [
      { x1: 200 + pa.pinOffset[0] + pa.labelLeft, y1: 200 + pa.pinOffset[1] + pa.labelTop, x2: 200 + pa.pinOffset[0] + pa.labelLeft + 80, y2: 200 + pa.pinOffset[1] + pa.labelTop + 22 },
      { x1: 200 + pb.pinOffset[0] + pb.labelLeft, y1: 200 + pb.pinOffset[1] + pb.labelTop, x2: 200 + pb.pinOffset[0] + pb.labelLeft + 80, y2: 200 + pb.pinOffset[1] + pb.labelTop + 22 },
      { x1: 200 + pc.pinOffset[0] + pc.labelLeft, y1: 200 + pc.pinOffset[1] + pc.labelTop, x2: 200 + pc.pinOffset[0] + pc.labelLeft + 80, y2: 200 + pc.pinOffset[1] + pc.labelTop + 22 },
    ];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const overlapX = Math.min(boxes[i].x2, boxes[j].x2) - Math.max(boxes[i].x1, boxes[j].x1);
        const overlapY = Math.min(boxes[i].y2, boxes[j].y2) - Math.max(boxes[i].y1, boxes[j].y1);
        expect(overlapX > 0 && overlapY > 0).toBe(false);
      }
    }
  });

  test('clusterBeikeHouses groups same resblock and filters by viewport', () => {
    const sample = [
      {
        house_code: 'BJ1',
        title: '望京新城 1居',
        price: 4200,
        price_text: '4200',
        price_unit: '元/月',
        lng: 116.48,
        lat: 40.0,
        layout: '1室1厅',
        area: 50,
        bedrooms: 1,
        bathrooms: 1,
        orientation: '南',
        floor_total: 18,
        district: '朝阳',
        bizcircle: '望京',
        resblock: '望京新城',
        subway_desc: '',
        subway_name: '',
        rent_type: 'whole' as const,
        tags: [],
      },
      {
        house_code: 'BJ2',
        title: '望京新城 2居',
        price: 3800,
        price_text: '3800',
        price_unit: '元/月',
        lng: 116.48,
        lat: 40.0,
        layout: '2室1厅',
        area: 70,
        bedrooms: 2,
        bathrooms: 1,
        orientation: '南北',
        floor_total: 18,
        district: '朝阳',
        bizcircle: '望京',
        resblock: '望京新城',
        subway_desc: '',
        subway_name: '',
        rent_type: 'whole' as const,
        tags: [],
      },
      {
        house_code: 'BJ3',
        title: '回龙观 1居',
        price: 3000,
        price_text: '3000',
        price_unit: '元/月',
        lng: 116.33,
        lat: 40.07,
        layout: '1室1厅',
        area: 45,
        bedrooms: 1,
        bathrooms: 1,
        orientation: '南',
        floor_total: 6,
        district: '昌平',
        bizcircle: '回龙观',
        resblock: '龙跃苑',
        subway_desc: '',
        subway_name: '',
        rent_type: 'whole' as const,
        tags: [],
      },
    ];

    const all = clusterBeikeHouses(sample);
    expect(all.length).toBe(2);
    expect(all[0].resblock).toBe('龙跃苑');
    expect(all[1].resblock).toBe('望京新城');
    expect(all[1].houses.length).toBe(2);
    expect(all[1].minPrice).toBe(3800);
    expect(all[1].maxPrice).toBe(4200);

    const inView = clusterBeikeHouses(sample, [
      [116.45, 39.98],
      [116.52, 40.02],
    ]);
    expect(inView.length).toBe(1);
    expect(inView[0].resblock).toBe('望京新城');

    const byKw = clusterBeikeHouses(sample, null, '望京 南北');
    expect(byKw.length).toBe(1);
    expect(byKw[0].houses.length).toBe(1);
    expect(byKw[0].houses[0].house_code).toBe('BJ2');

    // 多选商圈为 OR 关系，且可与关键词 AND 组合
    const byBizOr = clusterBeikeHouses(sample, null, '', ['望京', '回龙观']);
    expect(byBizOr.length).toBe(2);
    const byBizAndKw = clusterBeikeHouses(sample, null, '1室1厅', ['望京', '回龙观']);
    expect(byBizAndKw.length).toBe(2);
    expect(byBizAndKw.reduce((acc, c) => acc + c.houses.length, 0)).toBe(2);

    // CSV 导出：默认不含图片列、不含 house_code；开启含图后图片 URL 在最后一列
    const sampleWithPic = [{ ...sample[0], pic_url: 'https://ke-image.ljcdn.com/test.1500x1500.jpg' }];
    const csvNoPic = formatBeikeHousesCSV(sampleWithPic, false);
    expect(csvNoPic).not.toContain('BJ1');
    expect(csvNoPic).not.toContain('图片URL');
    expect(csvNoPic).toContain('坐标(GCJ02)');
    expect(csvNoPic).toContain('望京新城 1居');

    const csvWithPic = formatBeikeHousesCSV(sampleWithPic, true);
    const [headerLine, rowLine] = csvWithPic.split('\n');
    expect(headerLine.endsWith(',图片URL')).toBe(true);
    expect(rowLine.endsWith(',https://ke-image.ljcdn.com/test.1500x1500.jpg')).toBe(true);

    // 挂牌天数中位数与热度分级
    const now = Date.parse('2026-11-25T12:00:00+08:00');
    const dated = [
      { ...sample[0], listed_at: '2026-11-20' }, // 5 天
      { ...sample[1], listed_at: '2026-11-15' }, // 10 天 -> 中位 8 天 (hot)
      { ...sample[2], listed_at: '2026-09-20' }, // 66 天 (slow)
    ];
    const colored = clusterBeikeHouses(dated, null, '', [], now);
    const wangjing = colored.find((c) => c.resblock === '望京新城')!;
    const huilong = colored.find((c) => c.resblock === '龙跃苑')!;
    expect(wangjing.liquidity).toBe('hot');
    expect(wangjing.medianListedDays).toBe(8);
    expect(huilong.liquidity).toBe('slow');
    expect(huilong.medianListedDays).toBeGreaterThan(45);

    // 按气泡着色筛选（空数组不限，多选为 OR）
    expect(filterBeikeClustersByLiquidity(colored, []).length).toBe(2);
    expect(filterBeikeClustersByLiquidity(colored, ['hot']).map((c) => c.resblock)).toEqual(['望京新城']);
    expect(filterBeikeClustersByLiquidity(colored, ['slow']).map((c) => c.resblock)).toEqual(['龙跃苑']);
    expect(filterBeikeClustersByLiquidity(colored, ['hot', 'slow']).length).toBe(2);
    expect(filterBeikeClustersByLiquidity(colored, ['normal']).length).toBe(0);
  });
});
