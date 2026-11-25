import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { extractErrorMessage, findHighwayBypassAnchors, planRoute, type BypassOption } from '../api/client';
import { createAlignedWebGLLayer, type WebGLTileProvider } from '../map/customTileLayer';
import {
  BASEMAPS,
  OVERLAYS,
  computeDetourWindow,
  computeLabelPlacements,
  displayToWgs84,
  estimateLabelWidth,
  findNearestSegmentInsertIndex,
  findNearestVertexIndex,
  formatArea,
  formatDistance,
  geometryToDisplay,
  haversineMeters,
  isViewportInsidePolygon,
  lineLengthMeters,
  polygonAreaSqMeters,
  spliceLineSegment,
  wgs84ToDisplay,
  type LabelLayoutItem,
  type WgsBounds,
} from '../map/geo';
import type {
  BasemapId,
  BeikeCluster,
  DrawTool,
  GeoGeometry,
  MapFeature,
  OverlayId,
  PlaceResult,
  RouteMode,
  RouteProvider,
  RouteResult,
  RouteSegmentMode,
  TrafficSegment,
} from '../types/map';

interface MapCanvasProps {
  basemap: BasemapId;
  overlay: OverlayId;
  showTraffic: boolean;
  canEdit: boolean;
  initialCenter: [number, number];
  initialZoom: number;
  features: MapFeature[];
  selectedFeatureId: string | null;
  editingLineFeatureId: string | null;
  searchResults: PlaceResult[];
  activeSearchIndex: number | null;
  beikeClusters: BeikeCluster[];
  activeBeikeClusterKey: string | null;
  trafficOverlay: TrafficSegment[] | null;
  tool: DrawTool;
  flyTarget: {
    lng: number;
    lat: number;
    zoom?: number;
    bounds?: [[number, number], [number, number]];
    seq: number;
  } | null;
  userLocation: [number, number] | null;
  externalWaypoint?: { coord: [number, number]; name?: string; seq: number } | null;
  onSelectFeature: (id: string | null) => void;
  onSelectSearchResult?: (index: number) => void;
  onSelectBeikeCluster?: (key: string) => void;
  onCreateGeometry: (geometry: GeoGeometry) => void;
  onSaveRoute: (route: RouteResult, waypointNames: string[]) => void;
  onSaveEditedLine: (featureId: string, coords: [number, number][]) => void;
  onCancelEditLine: () => void;
  onToolCancel: () => void;
  onViewChange?: (view: { lng: number; lat: number; zoom: number }) => void;
  onViewportChange?: (viewport: { center: [number, number]; bounds: WgsBounds }) => void;
}

const FEATURES_SOURCE = 'little-map-features';
const DRAFT_SOURCE = 'little-map-draft';
const PREVIEW_SOURCE = 'little-map-search-preview';
const TRAFFIC_OVERLAY_SOURCE = 'little-map-traffic-overlay';
const BASEMAP_LAYER_PREFIX = 'basemap-layer-';
const OVERLAY_LAYER_PREFIX = 'overlay-layer-';

function basemapSourceId(id: BasemapId): string {
  return `basemap-src-${id}`;
}

function basemapLayerId(id: BasemapId): string {
  return `${BASEMAP_LAYER_PREFIX}${id}`;
}

function overlaySourceId(overlay: OverlayId, baseCrs: 'wgs84' | 'gcj02'): string {
  return `overlay-src-${overlay}-${baseCrs}`;
}

function overlayLayerId(overlay: OverlayId, baseCrs: 'wgs84' | 'gcj02'): string {
  return `${OVERLAY_LAYER_PREFIX}${overlay}-${baseCrs}`;
}

const customLayerRegistry = new WeakMap<maplibregl.Map, Set<string>>();

function addTrackedCustomLayer(
  map: maplibregl.Map,
  layer: maplibregl.CustomLayerInterface,
  beforeId?: string,
) {
  map.addLayer(layer, beforeId);
  let set = customLayerRegistry.get(map);
  if (!set) {
    set = new Set<string>();
    customLayerRegistry.set(map, set);
  }
  set.add(layer.id);
}

// 隐藏或移除同组非目标图层：MapLibre 的 custom WebGL 图层不支持 visibility layout，需直接 removeLayer 避免残留并释放 GPU 纹理。
function hideOtherLayers(map: maplibregl.Map, prefix: string, keepLayerId: string) {
  const customSet = customLayerRegistry.get(map);
  if (customSet) {
    for (const id of [...customSet]) {
      if (!id.startsWith(prefix) || id === keepLayerId) continue;
      if (map.getLayer(id)) {
        map.removeLayer(id);
      }
      customSet.delete(id);
    }
  }

  const style = map.getStyle();
  if (!style) return;
  for (const layer of style.layers ?? []) {
    if (!layer.id.startsWith(prefix) || layer.id === keepLayerId) continue;
    if (customSet?.has(layer.id)) continue;
    map.setLayoutProperty(layer.id, 'visibility', 'none');
  }
}

// 切换底图时保留普通 raster Source 缓存；custom WebGL 图层切换时直接移除释放显存。
function syncBasemapLayer(map: maplibregl.Map, basemap: BasemapId) {
  const style = map.getStyle();
  if (!style) return;

  const targetLayer = basemapLayerId(basemap);
  hideOtherLayers(map, BASEMAP_LAYER_PREFIX, targetLayer);

  if (map.getLayer(targetLayer)) {
    if (!customLayerRegistry.get(map)?.has(targetLayer)) {
      map.setLayoutProperty(targetLayer, 'visibility', 'visible');
    }
    return;
  }

  const cfg = BASEMAPS[basemap] ?? BASEMAPS['amap-vec'];
  const firstLayerId = map.getStyle()?.layers?.[0]?.id;

  // 百度底图使用 WebGL Custom Layer 直接贴原图纹理（0 裁剪、0 拼接、0 重编码）
  if (basemap === 'baidu-vec' || basemap === 'baidu-sat') {
    addTrackedCustomLayer(map, createAlignedWebGLLayer(targetLayer, basemap, 'wgs84', cfg.maxzoom), firstLayerId);
    return;
  }

  const srcId = basemapSourceId(basemap);
  if (!map.getSource(srcId)) {
    map.addSource(srcId, {
      type: 'raster',
      tiles: cfg.tiles,
      tileSize: 256,
      attribution: cfg.attribution,
      maxzoom: cfg.maxzoom,
    });
  }

  map.addLayer(
    {
      id: targetLayer,
      type: 'raster',
      source: srcId,
    },
    firstLayerId,
  );
}

// 切换路网叠加层时跨 CRS 使用 WebGL Custom Layer 贴原图纹理，切走时立即移除防止残留。
function syncOverlayLayer(map: maplibregl.Map, basemap: BasemapId, overlay: OverlayId) {
  const style = map.getStyle();
  if (!style) return;

  const baseCfg = BASEMAPS[basemap] ?? BASEMAPS['amap-vec'];
  const targetLayer = overlay === 'none' ? '' : overlayLayerId(overlay, baseCfg.crs);
  hideOtherLayers(map, OVERLAY_LAYER_PREFIX, targetLayer);

  if (overlay === 'none') return;

  if (map.getLayer(targetLayer)) {
    if (!customLayerRegistry.get(map)?.has(targetLayer)) {
      map.setLayoutProperty(targetLayer, 'visibility', 'visible');
    }
    return;
  }

  const ovCfg = OVERLAYS[overlay];
  if (!ovCfg) return;

  const beforeId = map.getLayer('features-fill') ? 'features-fill' : undefined;

  if (baseCfg.crs !== ovCfg.crs) {
    addTrackedCustomLayer(
      map,
      createAlignedWebGLLayer(targetLayer, overlay as WebGLTileProvider, baseCfg.crs, ovCfg.maxzoom),
      beforeId,
    );
    return;
  }

  if (ovCfg.tiles.length === 0) return;

  const srcId = overlaySourceId(overlay, baseCfg.crs);
  if (!map.getSource(srcId)) {
    map.addSource(srcId, {
      type: 'raster',
      tiles: ovCfg.tiles,
      tileSize: 256,
      maxzoom: ovCfg.maxzoom,
    });
  }

  map.addLayer(
    {
      id: targetLayer,
      type: 'raster',
      source: srcId,
    },
    beforeId,
  );
}

const TRAFFIC_TILE_LAYER_PREFIX = 'traffic-tile-layer-';
const TRAFFIC_TILE_SOURCE_PREFIX = 'traffic-tile-src-';

// 独立全图实时路况层，可与底图及地名/路网叠加层任意组合显示，位于标注层之下。
function syncTrafficTileLayer(map: maplibregl.Map, basemap: BasemapId, showTraffic: boolean) {
  const style = map.getStyle();
  if (!style) return;

  const baseCfg = BASEMAPS[basemap] ?? BASEMAPS['amap-vec'];
  const targetLayer = showTraffic ? `${TRAFFIC_TILE_LAYER_PREFIX}${baseCfg.crs}` : '';
  hideOtherLayers(map, TRAFFIC_TILE_LAYER_PREFIX, targetLayer);

  if (!showTraffic) return;

  if (map.getLayer(targetLayer)) {
    if (!customLayerRegistry.get(map)?.has(targetLayer)) {
      map.setLayoutProperty(targetLayer, 'visibility', 'visible');
    }
    return;
  }

  const beforeId = map.getLayer('features-fill') ? 'features-fill' : undefined;

  if (baseCfg.crs !== 'gcj02') {
    addTrackedCustomLayer(map, createAlignedWebGLLayer(targetLayer, 'amap-traffic', baseCfg.crs, 17), beforeId);
    return;
  }

  const srcId = `${TRAFFIC_TILE_SOURCE_PREFIX}${baseCfg.crs}`;
  if (!map.getSource(srcId)) {
    map.addSource(srcId, {
      type: 'raster',
      tiles: ['/api/tile-proxy?provider=amap-traffic&z={z}&x={x}&y={y}'],
      tileSize: 256,
      maxzoom: 17,
    });
  }

  map.addLayer(
    {
      id: targetLayer,
      type: 'raster',
      source: srcId,
    },
    beforeId,
  );
}

function buildBaseStyle(basemap: BasemapId): maplibregl.StyleSpecification {
  if (basemap === 'baidu-vec' || basemap === 'baidu-sat') {
    return {
      version: 8,
      sources: {},
      layers: [],
    };
  }
  const cfg = BASEMAPS[basemap] ?? BASEMAPS['amap-vec'];
  const srcId = basemapSourceId(basemap);
  return {
    version: 8,
    sources: {
      [srcId]: {
        type: 'raster',
        tiles: cfg.tiles,
        tileSize: 256,
        attribution: cfg.attribution,
        maxzoom: cfg.maxzoom,
      },
    },
    layers: [
      {
        id: basemapLayerId(basemap),
        type: 'raster',
        source: srcId,
      },
    ],
  };
}

function buildFeatureCollection(
  features: MapFeature[],
  basemap: BasemapId,
  selectedId: string | null,
  viewport: WgsBounds | null,
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: features
      .filter((f) => {
        if (!f.visible) return false;
        if (f.geometry.type === 'Polygon') {
          const ring = (f.geometry.coordinates as number[][][])[0] ?? [];
          if (isViewportInsidePolygon(viewport, ring)) {
            return false;
          }
        }
        return true;
      })
      .map((f) => ({
        type: 'Feature',
        id: f.id,
        geometry: geometryToDisplay(f.geometry, basemap) as GeoJSON.Geometry,
        properties: {
          id: f.id,
          title: f.title,
          color: f.color || '#2563eb',
          selected: f.id === selectedId ? 1 : 0,
        },
      })),
  };
}

const DRIVING_SEG_CYCLE: RouteSegmentMode[] = ['auto', 'highway', 'national', 'avoid-jam', 'direct'];

interface RouteDraftSnapshot {
  coords: [number, number][];
  names: string[];
  segmentModes: RouteSegmentMode[];
  avoidPoints: [number, number][];
  avoidSegments: [number, number][][];
}

const MAX_ROUTE_HISTORY = 30;

function segmentModeLabel(mode: RouteSegmentMode, routeMode: RouteMode): string {
  if (mode === 'direct') return '直线 ⇄';
  if (routeMode !== 'driving') return '贴路 ⇄';
  switch (mode) {
    case 'highway':
      return '高速 ⇄';
    case 'national':
      return '国道 ⇄';
    case 'avoid-jam':
      return '避堵 ⇄';
    default:
      return '智能 ⇄';
  }
}

function nextSegmentMode(cur: RouteSegmentMode, routeMode: RouteMode): RouteSegmentMode {
  if (routeMode !== 'driving') {
    return cur === 'direct' ? 'auto' : 'direct';
  }
  const idx = DRIVING_SEG_CYCLE.indexOf(cur);
  return DRIVING_SEG_CYCLE[(idx + 1) % DRIVING_SEG_CYCLE.length];
}

function formatDuration(seconds: number): string {
  const mins = Math.max(1, Math.round(seconds / 60));
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
  }
  return `${mins} 分钟`;
}

function buildDraftCollection(
  draftCoords: [number, number][],
  hoverCoord: [number, number] | null,
  tool: DrawTool,
  basemap: BasemapId,
  routeGeometry?: GeoGeometry | null,
  trafficSegments?: TrafficSegment[],
  avoidSegments?: [number, number][][],
): GeoJSON.FeatureCollection {
  if (draftCoords.length === 0 && (!avoidSegments || avoidSegments.length === 0)) {
    return { type: 'FeatureCollection', features: [] };
  }

  const fixedDisplay = draftCoords.map(([lng, lat]) => wgs84ToDisplay(lng, lat, basemap));
  const out: GeoJSON.Feature[] = fixedDisplay.map((coord) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: coord },
    properties: {},
  }));

  if (tool === 'route') {
    if (avoidSegments && avoidSegments.length > 0) {
      for (const seg of avoidSegments) {
        if (seg.length < 2) continue;
        out.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: seg.map(([lng, lat]) => wgs84ToDisplay(lng, lat, basemap)),
          },
          properties: { kind: 'avoid-seg' },
        });
      }
    }

    if (trafficSegments && trafficSegments.length > 0) {
      trafficSegments.forEach((seg, segIndex) => {
        if (seg.coordinates.length < 2) return;
        out.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: seg.coordinates.map(([lng, lat]) => wgs84ToDisplay(lng, lat, basemap)),
          },
          properties: { kind: 'traffic', color: seg.color, status: seg.status, segIndex },
        });
      });
    } else if (routeGeometry) {
      out.push({
        type: 'Feature',
        geometry: geometryToDisplay(routeGeometry, basemap) as GeoJSON.Geometry,
        properties: {},
      });
    } else if (fixedDisplay.length >= 2) {
      out.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: fixedDisplay },
        properties: {},
      });
    }
    return { type: 'FeatureCollection', features: out };
  }

  const previewWgs = hoverCoord ? [...draftCoords, hoverCoord] : draftCoords;
  const previewDisplay = previewWgs.map(([lng, lat]) => wgs84ToDisplay(lng, lat, basemap));

  if (previewDisplay.length >= 2) {
    const isPoly = tool === 'polygon' || tool === 'measure-area';
    if (isPoly && previewDisplay.length >= 3) {
      out.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[...previewDisplay, previewDisplay[0]]] },
        properties: {},
      });
    } else {
      out.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: previewDisplay },
        properties: {},
      });
    }
  }
  return { type: 'FeatureCollection', features: out };
}

function createMeasureMarker(
  map: maplibregl.Map,
  wgsCoord: [number, number],
  basemap: BasemapId,
  text: string,
  variant: 'seg' | 'node' | 'total',
  offset: [number, number] = [0, 0],
): maplibregl.Marker {
  const el = document.createElement('div');
  el.className = variant === 'seg' ? 'measure-tag' : `measure-tag ${variant}`;
  el.textContent = text;
  const displayCoord = wgs84ToDisplay(wgsCoord[0], wgsCoord[1], basemap);
  return new maplibregl.Marker({ element: el, offset }).setLngLat(displayCoord).addTo(map);
}

export function MapCanvas({
  basemap,
  overlay,
  showTraffic,
  canEdit,
  initialCenter,
  initialZoom,
  features,
  selectedFeatureId,
  editingLineFeatureId,
  searchResults,
  activeSearchIndex,
  beikeClusters,
  activeBeikeClusterKey,
  trafficOverlay,
  tool,
  flyTarget,
  userLocation,
  externalWaypoint,
  onSelectFeature,
  onSelectSearchResult,
  onSelectBeikeCluster,
  onCreateGeometry,
  onSaveRoute,
  onSaveEditedLine,
  onCancelEditLine,
  onToolCancel,
  onViewChange,
  onViewportChange,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<Map<string, maplibregl.Marker>>(new Map());
  const draftLabelsRef = useRef<maplibregl.Marker[]>([]);
  const editLineMarkersRef = useRef<maplibregl.Marker[]>([]);
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const searchMarkersRef = useRef<maplibregl.Marker[]>([]);
  const beikeMarkersRef = useRef<maplibregl.Marker[]>([]);
  const labelEntriesRef = useRef<{
    features: Array<{
      id: string;
      marker: maplibregl.Marker;
      tagEl: HTMLElement | null;
      displayCoord: [number, number];
      labelText: string;
      pinRadius: number;
      priority: number;
    }>;
    search: Array<{
      id: string;
      marker: maplibregl.Marker;
      tagEl: HTMLElement | null;
      displayCoord: [number, number];
      labelText: string;
      pinRadius: number;
      priority: number;
    }>;
    beike: Array<{
      id: string;
      marker: maplibregl.Marker;
      tagEl: HTMLElement | null;
      displayCoord: [number, number];
      labelText: string;
      pinRadius: number;
      priority: number;
    }>;
  }>({ features: [], search: [], beike: [] });
  const prevBasemapRef = useRef<BasemapId>(basemap);
  const routeReqSeqRef = useRef(0);

  function relayoutMapLabels(map: maplibregl.Map | null) {
    if (!map) return;
    const allEntries = [
      ...labelEntriesRef.current.search,
      ...labelEntriesRef.current.beike,
      ...labelEntriesRef.current.features,
    ];
    if (allEntries.length === 0) return;

    const layoutItems: LabelLayoutItem[] = allEntries.map((entry) => {
      const pt = map.project(entry.displayCoord);
      const measuredW = entry.tagEl?.offsetWidth ?? 0;
      const measuredH = entry.tagEl?.offsetHeight ?? 0;
      return {
        id: entry.id,
        x: pt.x,
        y: pt.y,
        width: entry.tagEl ? (measuredW > 0 ? measuredW : estimateLabelWidth(entry.labelText)) : 0,
        height: entry.tagEl ? (measuredH > 0 ? measuredH : 22) : 0,
        pinRadius: entry.pinRadius,
        priority: entry.priority,
      };
    });

    const placements = computeLabelPlacements(layoutItems, 22);
    for (const entry of allEntries) {
      const p = placements.get(entry.id);
      if (!p) continue;
      entry.marker.setOffset(p.pinOffset);
      if (entry.tagEl) {
        entry.tagEl.style.left = `${p.labelLeft}px`;
        entry.tagEl.style.top = `${p.labelTop}px`;
      }
    }
  }

  const [draftCoords, setDraftCoords] = useState<[number, number][]>([]);
  const [draftNames, setDraftNames] = useState<string[]>([]);
  const [hoverCoord, setHoverCoord] = useState<[number, number] | null>(null);
  const [measureFrozen, setMeasureFrozen] = useState(false);
  const [viewportBounds, setViewportBounds] = useState<WgsBounds | null>(null);
  const [routeMode, setRouteMode] = useState<RouteMode>('bicycling');
  const [routeProvider, setRouteProvider] = useState<RouteProvider>('auto');
  const [defaultSegMode, setDefaultSegMode] = useState<RouteSegmentMode>('auto');
  const [routeSegmentModes, setRouteSegmentModes] = useState<RouteSegmentMode[]>([]);
  const [routeAvoidPoints, setRouteAvoidPoints] = useState<[number, number][]>([]);
  const [routeAvoidSegments, setRouteAvoidSegments] = useState<[number, number][][]>([]);
  const [routeHistory, setRouteHistory] = useState<RouteDraftSnapshot[]>([]);
  const [pickingAvoidPoint, setPickingAvoidPoint] = useState(false);
  const [smartBypassEnabled, setSmartBypassEnabled] = useState(false);
  const [bypassLoading, setBypassLoading] = useState(false);
  const [bypassState, setBypassState] = useState<{
    baseCoords: [number, number][];
    baseNames: string[];
    baseModes: RouteSegmentMode[];
    baseAvoidSegments: [number, number][][];
    avoidSeg: [number, number][];
    segIdx: number;
    insertAt: number;
    summary: string;
    options: BypassOption[];
    activeId: string;
  } | null>(null);
  const [routeResult, setRouteResult] = useState<RouteResult | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState('');
  const [editingLineCoords, setEditingLineCoords] = useState<[number, number][]>([]);
  const [detourViaPoints, setDetourViaPoints] = useState<[number, number][]>([]);
  const [detourWindow, setDetourWindow] = useState<{ startIdx: number; endIdx: number } | null>(null);
  const [detourManualRange, setDetourManualRange] = useState(false);
  const [detourPreviewCoords, setDetourPreviewCoords] = useState<[number, number][] | null>(null);
  const [editSnapToRoad, setEditSnapToRoad] = useState(true);
  const [editRerouting, setEditRerouting] = useState(false);
  const [editRouteError, setEditRouteError] = useState('');
  const detourReqSeqRef = useRef(0);

  const latestRef = useRef({
    basemap,
    overlay,
    showTraffic,
    features,
    selectedFeatureId,
    editingLineFeatureId,
    searchResults,
    activeSearchIndex,
    trafficOverlay,
    viewportBounds,
    tool,
    draftCoords,
    draftNames,
    routeSegmentModes,
    routeAvoidPoints,
    routeAvoidSegments,
    routeProvider,
    defaultSegMode,
    pickingAvoidPoint,
    smartBypassEnabled,
    routeResult,
    hoverCoord,
    measureFrozen,
    onSelectFeature,
    onSelectSearchResult,
    onSelectBeikeCluster,
    onCreateGeometry,
    onViewChange,
    onViewportChange,
  });
  latestRef.current = {
    basemap,
    overlay,
    showTraffic,
    features,
    selectedFeatureId,
    editingLineFeatureId,
    searchResults,
    activeSearchIndex,
    trafficOverlay,
    viewportBounds,
    tool,
    draftCoords,
    draftNames,
    routeSegmentModes,
    routeAvoidPoints,
    routeAvoidSegments,
    routeProvider,
    defaultSegMode,
    pickingAvoidPoint,
    smartBypassEnabled,
    routeResult,
    hoverCoord,
    measureFrozen,
    onSelectFeature,
    onSelectSearchResult,
    onSelectBeikeCluster,
    onCreateGeometry,
    onViewChange,
    onViewportChange,
  };

  function captureRouteSnapshot(): RouteDraftSnapshot {
    const cur = latestRef.current;
    return {
      coords: cur.draftCoords.map((p) => [p[0], p[1]] as [number, number]),
      names: [...cur.draftNames],
      segmentModes: [...cur.routeSegmentModes],
      avoidPoints: cur.routeAvoidPoints.map((p) => [p[0], p[1]] as [number, number]),
      avoidSegments: cur.routeAvoidSegments.map((seg) => seg.map((p) => [p[0], p[1]] as [number, number])),
    };
  }

  function pushRouteHistory(customSnap?: RouteDraftSnapshot) {
    const snap = customSnap ?? captureRouteSnapshot();
    setRouteHistory((prev) => {
      const next = [...prev, snap];
      return next.length > MAX_ROUTE_HISTORY ? next.slice(next.length - MAX_ROUTE_HISTORY) : next;
    });
  }

  function undoRouteStep() {
    setRouteHistory((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setDraftCoords(last.coords);
      setDraftNames(last.names);
      setRouteSegmentModes(last.segmentModes);
      setRouteAvoidPoints(last.avoidPoints);
      setRouteAvoidSegments(last.avoidSegments);
      setBypassLoading(false);
      setBypassState(null);
      return prev.slice(0, -1);
    });
  }

  function applyBypassOption(
    snapshot: {
      baseCoords: [number, number][];
      baseNames: string[];
      baseModes: RouteSegmentMode[];
      baseAvoidSegments: [number, number][][];
      avoidSeg: [number, number][];
      segIdx: number;
      insertAt: number;
    },
    opt: BypassOption,
  ) {
    const { baseCoords, baseNames, baseModes, baseAvoidSegments, avoidSeg, segIdx, insertAt } = snapshot;
    const paddedModes = [...baseModes];
    while (paddedModes.length < Math.max(0, baseCoords.length - 1)) {
      paddedModes.push(latestRef.current.defaultSegMode);
    }

    if (opt.kind === 'official') {
      setDraftCoords(baseCoords);
      setDraftNames(baseNames);
      setRouteSegmentModes([
        ...paddedModes.slice(0, segIdx),
        opt.segment_modes[0] ?? 'avoid-jam',
        ...paddedModes.slice(segIdx + 1),
      ]);
      setRouteAvoidSegments([...baseAvoidSegments, avoidSeg]);
      return;
    }

    const addedPts: [number, number][] = [];
    const addedNames: string[] = [];
    if (opt.before) {
      addedPts.push([opt.before.lng, opt.before.lat]);
      addedNames.push(opt.before.name);
    }
    if (opt.after) {
      addedPts.push([opt.after.lng, opt.after.lat]);
      addedNames.push(opt.after.name);
    }
    setDraftCoords([...baseCoords.slice(0, insertAt), ...addedPts, ...baseCoords.slice(insertAt)]);
    setDraftNames([...baseNames.slice(0, insertAt), ...addedNames, ...baseNames.slice(insertAt)]);
    setRouteSegmentModes([
      ...paddedModes.slice(0, segIdx),
      ...opt.segment_modes,
      ...paddedModes.slice(segIdx + 1),
    ]);
    // 拆段后由收费站+国道段负责绕行，不再叠加原拥堵带避免干扰
    setRouteAvoidSegments(baseAvoidSegments);
  }

  function ensureVectorLayers(map: maplibregl.Map) {
    const {
      features: curFeatures,
      basemap: curBasemap,
      selectedFeatureId: curSel,
      viewportBounds: curViewport,
      draftCoords: curDraft,
      tool: curTool,
    } = latestRef.current;

    if (!map.getSource(FEATURES_SOURCE)) {
      map.addSource(FEATURES_SOURCE, {
        type: 'geojson',
        data: buildFeatureCollection(curFeatures, curBasemap, curSel, curViewport),
      });

      map.addLayer({
        id: 'features-fill',
        type: 'fill',
        source: FEATURES_SOURCE,
        filter: ['==', '$type', 'Polygon'],
        paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': ['case', ['==', ['get', 'selected'], 1], 0.38, 0.22],
        },
      });

      map.addLayer({
        id: 'features-line',
        type: 'line',
        source: FEATURES_SOURCE,
        filter: ['in', '$type', 'LineString', 'Polygon'],
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['case', ['==', ['get', 'selected'], 1], 4.5, 3],
          'line-opacity': 0.92,
        },
      });
    }

    if (!map.getSource(DRAFT_SOURCE)) {
      map.addSource(DRAFT_SOURCE, {
        type: 'geojson',
        data: buildDraftCollection(curDraft, latestRef.current.measureFrozen ? null : latestRef.current.hoverCoord, curTool, curBasemap),
      });

      map.addLayer({
        id: 'draft-fill',
        type: 'fill',
        source: DRAFT_SOURCE,
        filter: ['==', '$type', 'Polygon'],
        paint: {
          'fill-color': '#f59e0b',
          'fill-opacity': 0.24,
        },
      });

      map.addLayer({
        id: 'draft-line',
        type: 'line',
        source: DRAFT_SOURCE,
        filter: [
          'all',
          ['any', ['==', ['geometry-type'], 'LineString'], ['==', ['geometry-type'], 'Polygon']],
          ['!=', ['get', 'kind'], 'traffic'],
          ['!=', ['get', 'kind'], 'avoid-seg'],
        ],
        paint: {
          'line-color': '#f59e0b',
          'line-width': 3,
          'line-dasharray': [2, 1.5],
        },
      });

      map.addLayer({
        id: 'draft-avoid-seg-line',
        type: 'line',
        source: DRAFT_SOURCE,
        filter: ['==', ['get', 'kind'], 'avoid-seg'],
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-color': '#dc2626',
          'line-width': 11,
          'line-opacity': 0.42,
        },
      });

      map.addLayer({
        id: 'draft-traffic-line',
        type: 'line',
        source: DRAFT_SOURCE,
        filter: ['==', ['get', 'kind'], 'traffic'],
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-color': ['coalesce', ['get', 'color'], '#2563eb'],
          'line-width': 5.5,
          'line-opacity': 0.92,
        },
      });

      map.addLayer({
        id: 'draft-points',
        type: 'circle',
        source: DRAFT_SOURCE,
        filter: ['==', '$type', 'Point'],
        paint: {
          'circle-radius': 5,
          'circle-color': '#ffffff',
          'circle-stroke-color': '#f59e0b',
          'circle-stroke-width': 2.5,
        },
      });
    }

    if (!map.getSource(PREVIEW_SOURCE)) {
      const curResults = latestRef.current.searchResults;
      const curActive = latestRef.current.activeSearchIndex;
      const preview =
        curActive !== null ? curResults[curActive] : curResults.length === 1 ? curResults[0] : null;
      const previewData: GeoJSON.FeatureCollection =
        preview?.boundary
          ? {
              type: 'FeatureCollection',
              features: [
                {
                  type: 'Feature',
                  geometry: geometryToDisplay(preview.boundary, curBasemap) as GeoJSON.Geometry,
                  properties: {},
                },
              ],
            }
          : { type: 'FeatureCollection', features: [] };

      map.addSource(PREVIEW_SOURCE, {
        type: 'geojson',
        data: previewData,
      });

      map.addLayer({
        id: 'preview-fill',
        type: 'fill',
        source: PREVIEW_SOURCE,
        paint: {
          'fill-color': '#ef4444',
          'fill-opacity': 0.14,
        },
      });

      map.addLayer({
        id: 'preview-line',
        type: 'line',
        source: PREVIEW_SOURCE,
        paint: {
          'line-color': '#ef4444',
          'line-width': 2.5,
          'line-dasharray': [3, 2],
        },
      });
    }

    if (!map.getSource(TRAFFIC_OVERLAY_SOURCE)) {
      map.addSource(TRAFFIC_OVERLAY_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      map.addLayer({
        id: 'traffic-overlay-line',
        type: 'line',
        source: TRAFFIC_OVERLAY_SOURCE,
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-color': ['coalesce', ['get', 'color'], '#2563eb'],
          'line-width': 5.5,
          'line-opacity': 0.94,
        },
      });
    }
  }

  // 初始化 MapLibre 实例
  useEffect(() => {
    if (!containerRef.current) return;

    const displayCenter = wgs84ToDisplay(initialCenter[0], initialCenter[1], basemap);
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildBaseStyle(basemap),
      center: displayCenter,
      zoom: initialZoom,
      doubleClickZoom: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    mapRef.current = map;

    const updateViewportBounds = () => {
      const b = map.getBounds();
      const curBasemap = latestRef.current.basemap;
      const sw = displayToWgs84(b.getWest(), b.getSouth(), curBasemap);
      const ne = displayToWgs84(b.getEast(), b.getNorth(), curBasemap);
      const nextBounds: WgsBounds = [sw, ne];
      setViewportBounds(nextBounds);
      const center = map.getCenter();
      const [cLng, cLat] = displayToWgs84(center.lng, center.lat, curBasemap);
      latestRef.current.onViewportChange?.({
        center: [Number(cLng.toFixed(6)), Number(cLat.toFixed(6))],
        bounds: nextBounds,
      });
    };

    map.on('style.load', () => {
      ensureVectorLayers(map);
      syncBasemapLayer(map, latestRef.current.basemap);
      syncOverlayLayer(map, latestRef.current.basemap, latestRef.current.overlay);
      syncTrafficTileLayer(map, latestRef.current.basemap, latestRef.current.showTraffic);
      updateViewportBounds();
    });

    map.on('mousedown', () => {
      // MapLibre 会阻止 canvas 默认 mousedown 行为，导致页面残留选区或输入框焦点未清除，
      // 从而在 mouseup 时误触发浏览器划词翻译插件；此处主动清理。
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        sel.removeAllRanges();
      }
      const active = document.activeElement as HTMLElement | null;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
        active.blur();
      }
    });

    map.on('click', (ev) => {
      const {
        tool: curTool,
        basemap: curBasemap,
        editingLineFeatureId: curEditLineId,
        onSelectFeature: selCb,
        onCreateGeometry: createCb,
      } = latestRef.current;

      // 局部换路模式下：点击地图添加必经途经点
      if (curEditLineId) {
        const [wLng, wLat] = displayToWgs84(ev.lngLat.lng, ev.lngLat.lat, curBasemap);
        const viaPt: [number, number] = [Number(wLng.toFixed(6)), Number(wLat.toFixed(6))];
        setDetourViaPoints((prev) => [...prev, viaPt]);
        return;
      }

      if (curTool === 'select') {
        const hitLayers = ['features-line', 'features-fill'].filter((id) => map.getLayer(id));
        const hits = hitLayers.length > 0 ? map.queryRenderedFeatures(ev.point, { layers: hitLayers }) : [];
        if (hits.length > 0 && hits[0].properties?.id) {
          selCb(String(hits[0].properties.id));
        } else {
          selCb(null);
        }
        return;
      }

      const [wLng, wLat] = displayToWgs84(ev.lngLat.lng, ev.lngLat.lat, curBasemap);
      const nextPt: [number, number] = [Number(wLng.toFixed(6)), Number(wLat.toFixed(6))];
      if (curTool === 'point') {
        createCb({ type: 'Point', coordinates: nextPt });
        return;
      }

      if (latestRef.current.measureFrozen) {
        setMeasureFrozen(false);
        setDraftCoords([nextPt]);
        setHoverCoord(null);
        return;
      }

      if (curTool === 'route' && latestRef.current.pickingAvoidPoint) {
        // 点中实时路况段：调用后端 /api/route/bypass 沿高速走廊搜索真实收费站/出入口，自动拆成三段接力
        if (map.getLayer('draft-traffic-line')) {
          const hits = map.queryRenderedFeatures(ev.point, { layers: ['draft-traffic-line'] });
          const rawIdx = hits[0]?.properties?.segIndex;
          const segIndex = typeof rawIdx === 'number' ? rawIdx : Number(rawIdx);
          const curRes = latestRef.current.routeResult;
          const hitSeg = !Number.isNaN(segIndex) ? curRes?.traffic_segments?.[segIndex] : undefined;
          if (hitSeg && hitSeg.coordinates.length >= 2) {
            const avoidCoords = hitSeg.coordinates.map(([lng, lat]): [number, number] => [lng, lat]);
            const fullLine = (curRes?.geometry.coordinates as number[][] | undefined)?.map(
              ([lng, lat]): [number, number] => [lng, lat],
            );
            const curWps = latestRef.current.draftCoords;
            const curNames = latestRef.current.draftNames;
            const curModes = latestRef.current.routeSegmentModes;
            const curAvoidSegs = latestRef.current.routeAvoidSegments;
            const insertAt = findNearestSegmentInsertIndex(curWps, avoidCoords[Math.floor(avoidCoords.length / 2)]);
            const segIdx = Math.max(0, insertAt - 1);

            // 仅当开启「智能拆段」开关时才启动收费站搜索 + 多方案真实算路赛马；关闭时纯粹走官方 avoidpolygons 避堵
            if (latestRef.current.smartBypassEnabled && fullLine && fullLine.length >= 4) {
              const historySnap = captureRouteSnapshot();
              const snapshot = {
                baseCoords: [...curWps],
                baseNames: [...curNames],
                baseModes: [...curModes],
                baseAvoidSegments: [...curAvoidSegs],
                avoidSeg: avoidCoords,
                segIdx,
                insertAt,
              };
              setBypassLoading(true);
              setBypassState(null);
              const segStart = curWps[segIdx];
              const segEnd = curWps[Math.min(segIdx + 1, curWps.length - 1)];
              const origMode = curModes[segIdx] ?? latestRef.current.defaultSegMode;

              void findHighwayBypassAnchors({
                route_coords: fullLine,
                traffic_segments: curRes?.traffic_segments,
                clicked_segment_idx: segIndex,
                avoid_segment: avoidCoords,
                start_point: segStart,
                end_point: segEnd,
                orig_mode: origMode,
                orig_duration_seconds: curRes?.duration_seconds,
                orig_distance_meters: curRes?.distance_meters,
                provider: latestRef.current.routeProvider,
              })
                .then((res) => {
                  const chosen =
                    res.options.find((o) => o.id === res.recommended_id) ?? res.options[0];
                  pushRouteHistory(historySnap);
                  if (!chosen) {
                    setRouteAvoidSegments([...snapshot.baseAvoidSegments, avoidCoords]);
                    return;
                  }
                  applyBypassOption(snapshot, chosen);
                  setBypassState({
                    ...snapshot,
                    summary: res.summary,
                    options: res.options,
                    activeId: chosen.id,
                  });
                })
                .catch(() => {
                  pushRouteHistory(historySnap);
                  setRouteAvoidSegments([...snapshot.baseAvoidSegments, avoidCoords]);
                })
                .finally(() => {
                  setBypassLoading(false);
                });
              return;
            }

            pushRouteHistory();
            setRouteAvoidSegments((prev) => [...prev, avoidCoords]);
            return;
          }
        }
        pushRouteHistory();
        setRouteAvoidPoints((prev) => [...prev, nextPt]);
        return;
      }

      if (curTool === 'route' && latestRef.current.draftCoords.length >= 2) {
        const routeLayers = ['draft-line', 'draft-traffic-line'].filter((id) => map.getLayer(id));
        const lineHits = routeLayers.length > 0 ? map.queryRenderedFeatures(ev.point, { layers: routeLayers }) : [];
        if (lineHits.length > 0) {
          pushRouteHistory();
          setBypassState(null);
          const insertIdx = findNearestSegmentInsertIndex(latestRef.current.draftCoords, nextPt);
          setDraftCoords((prev) => [...prev.slice(0, insertIdx), nextPt, ...prev.slice(insertIdx)]);
          setDraftNames((names) => [...names.slice(0, insertIdx), '', ...names.slice(insertIdx)]);
          setRouteSegmentModes((modes) => {
            const inherited = modes[insertIdx - 1] ?? latestRef.current.defaultSegMode;
            return [...modes.slice(0, insertIdx - 1), inherited, inherited, ...modes.slice(insertIdx)];
          });
          return;
        }
      }

      if (curTool === 'route') {
        const curCoords = latestRef.current.draftCoords;
        const last = curCoords[curCoords.length - 1];
        if (last && Math.abs(last[0] - nextPt[0]) < 1e-7 && Math.abs(last[1] - nextPt[1]) < 1e-7) {
          return;
        }
        pushRouteHistory();
        setBypassState(null);
      }

      setDraftCoords((prev) => {
        const last = prev[prev.length - 1];
        if (last && Math.abs(last[0] - nextPt[0]) < 1e-7 && Math.abs(last[1] - nextPt[1]) < 1e-7) {
          return prev;
        }
        setDraftNames((names) => [...names, '']);
        if (curTool === 'route' && prev.length >= 1) {
          setRouteSegmentModes((modes) => [...modes, latestRef.current.defaultSegMode]);
        }
        return [...prev, nextPt];
      });
    });

    map.on('mousemove', (ev) => {
      const { tool: curTool, basemap: curBasemap, draftCoords: curDraft, measureFrozen: frozen } = latestRef.current;
      if (
        frozen ||
        curDraft.length === 0 ||
        (curTool !== 'line' && curTool !== 'polygon' && curTool !== 'measure-distance' && curTool !== 'measure-area')
      ) {
        return;
      }
      const [wLng, wLat] = displayToWgs84(ev.lngLat.lng, ev.lngLat.lat, curBasemap);
      setHoverCoord([Number(wLng.toFixed(6)), Number(wLat.toFixed(6))]);
    });

    map.on('mouseout', () => {
      setHoverCoord(null);
    });

    map.on('dblclick', (ev) => {
      const { tool: curTool, draftCoords: curDraft } = latestRef.current;
      if (curTool === 'line' || curTool === 'polygon') {
        ev.preventDefault();
        finishDraft();
      } else if ((curTool === 'measure-distance' || curTool === 'measure-area') && curDraft.length >= 2) {
        ev.preventDefault();
        setMeasureFrozen(true);
        setHoverCoord(null);
      }
    });

    map.on('moveend', () => {
      updateViewportBounds();
      const cb = latestRef.current.onViewChange;
      if (!cb) return;
      const center = map.getCenter();
      const [wLng, wLat] = displayToWgs84(center.lng, center.lat, latestRef.current.basemap);
      cb({
        lng: Number(wLng.toFixed(6)),
        lat: Number(wLat.toFixed(6)),
        zoom: Number(map.getZoom().toFixed(2)),
      });
    });

    map.on('zoomend', () => {
      relayoutMapLabels(map);
    });

    return () => {
      for (const marker of markersRef.current.values()) {
        marker.remove();
      }
      markersRef.current.clear();
      for (const label of draftLabelsRef.current) {
        label.remove();
      }
      draftLabelsRef.current = [];
      for (const m of editLineMarkersRef.current) {
        m.remove();
      }
      editLineMarkersRef.current = [];
      userMarkerRef.current?.remove();
      userMarkerRef.current = null;
      for (const m of searchMarkersRef.current) {
        m.remove();
      }
      searchMarkersRef.current = [];
      for (const m of beikeMarkersRef.current) {
        m.remove();
      }
      beikeMarkersRef.current = [];
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切换工具时清空未完成草图并更新光标样式
  useEffect(() => {
    setDraftCoords([]);
    setDraftNames([]);
    setRouteSegmentModes([]);
    setRouteAvoidPoints([]);
    setRouteAvoidSegments([]);
    setRouteHistory([]);
    setPickingAvoidPoint(false);
    setBypassLoading(false);
    setBypassState(null);
    setHoverCoord(null);
    setMeasureFrozen(false);
    setRouteResult(null);
    setRouteError('');
    setRouteLoading(false);
    const map = mapRef.current;
    if (map) {
      map.getCanvas().style.cursor = tool === 'select' ? '' : 'crosshair';
    }
  }, [tool]);

  // 路线规划模式下支持 Ctrl/Cmd + Z 快捷键撤销上一步操作
  useEffect(() => {
    if (tool !== 'route') return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (!(ev.metaKey || ev.ctrlKey) || ev.shiftKey || ev.key.toLowerCase() !== 'z') return;
      const target = ev.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      ev.preventDefault();
      undoRouteStep();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [tool]);

  // 接收来自侧边栏点选的已有标注点作为规划途经点
  useEffect(() => {
    if (!externalWaypoint || tool !== 'route') return;
    const pt: [number, number] = [
      Number(externalWaypoint.coord[0].toFixed(6)),
      Number(externalWaypoint.coord[1].toFixed(6)),
    ];
    const curCoords = latestRef.current.draftCoords;
    const last = curCoords[curCoords.length - 1];
    if (last && Math.abs(last[0] - pt[0]) < 1e-7 && Math.abs(last[1] - pt[1]) < 1e-7) {
      return;
    }
    pushRouteHistory();
    setBypassState(null);
    setDraftCoords((prev) => {
      const prevLast = prev[prev.length - 1];
      if (prevLast && Math.abs(prevLast[0] - pt[0]) < 1e-7 && Math.abs(prevLast[1] - pt[1]) < 1e-7) {
        return prev;
      }
      setDraftNames((names) => [...names, externalWaypoint.name ?? '']);
      if (prev.length >= 1) {
        setRouteSegmentModes((modes) => [...modes, latestRef.current.defaultSegMode]);
      }
      return [...prev, pt];
    });
  }, [externalWaypoint, tool]);

  // 规划模式下途经点 >= 2 时自动请求骑行/徒步路线（支持分段贴路/直线与切换数据源）
  useEffect(() => {
    if (tool !== 'route' || draftCoords.length < 2) {
      setRouteResult(null);
      setRouteError('');
      setRouteLoading(false);
      return;
    }

    const seq = ++routeReqSeqRef.current;
    setRouteLoading(true);
    setRouteError('');

    void planRoute(routeMode, draftCoords, routeProvider, routeSegmentModes, routeAvoidPoints, routeAvoidSegments)
      .then((res) => {
        if (routeReqSeqRef.current !== seq) return;
        setRouteResult(res);
      })
      .catch((err) => {
        if (routeReqSeqRef.current !== seq) return;
        setRouteResult(null);
        setRouteError(extractErrorMessage(err).message);
      })
      .finally(() => {
        if (routeReqSeqRef.current === seq) {
          setRouteLoading(false);
        }
      });
  }, [tool, routeMode, routeProvider, routeSegmentModes, routeAvoidPoints, routeAvoidSegments, draftCoords]);

  // 进入/退出已保存折线的「局部换路」模式（保留 100% 原始顶点）
  useEffect(() => {
    const map = mapRef.current;
    if (!editingLineFeatureId) {
      setEditingLineCoords([]);
      setDetourViaPoints([]);
      setDetourWindow(null);
      setDetourManualRange(false);
      setDetourPreviewCoords(null);
      setEditRerouting(false);
      setEditRouteError('');
      if (map) map.getCanvas().style.cursor = tool === 'select' ? '' : 'crosshair';
      return;
    }
    const target = features.find((f) => f.id === editingLineFeatureId);
    if (!target || target.geometry.type !== 'LineString') {
      setEditingLineCoords([]);
      return;
    }
    const fullCoords: [number, number][] = (target.geometry.coordinates as number[][]).map(([lng, lat]) => [
      lng,
      lat,
    ]);
    setEditingLineCoords(fullCoords);
    setDetourViaPoints([]);
    setDetourWindow(null);
    setDetourManualRange(false);
    setDetourPreviewCoords(null);
    setEditRouteError('');
    if (map) map.getCanvas().style.cursor = 'crosshair';
    if (target.category === '徒步路线') {
      setRouteMode('walking');
    } else if (target.category === '驾车路线') {
      setRouteMode('driving');
    } else if (target.category === '骑行路线') {
      setRouteMode('bicycling');
    }
  }, [editingLineFeatureId, features, tool]);

  // 必经点或出行方式变化时，自动按偏离距离计算建议的换路范围 [startIdx .. endIdx]
  useEffect(() => {
    if (!editingLineFeatureId || editingLineCoords.length < 2 || detourViaPoints.length === 0) {
      setDetourWindow(null);
      setDetourPreviewCoords(null);
      setDetourManualRange(false);
      return;
    }
    if (!detourManualRange) {
      setDetourWindow(computeDetourWindow(editingLineCoords, detourViaPoints, routeMode));
    }
  }, [editingLineFeatureId, editingLineCoords, detourViaPoints, routeMode, detourManualRange]);

  // 换路范围 + 必经点变化时，自动请求 [S, 必经点..., E] 局部重规划预览
  useEffect(() => {
    if (!editingLineFeatureId || !detourWindow || detourViaPoints.length === 0 || editingLineCoords.length < 2) {
      setDetourPreviewCoords(null);
      setEditRerouting(false);
      setEditRouteError('');
      return;
    }

    const startPt = editingLineCoords[detourWindow.startIdx];
    const endPt = editingLineCoords[detourWindow.endIdx];
    if (!startPt || !endPt) return;

    const waypoints: [number, number][] = [startPt, ...detourViaPoints, endPt];
    // 必经段直线模式且有 >=2 个必经点（如隧道入口..出口）时：两端 S->P1 与 Pk->E 走贴路规划，仅中间 P1..Pk 走直线
    let segModes: RouteSegmentMode[] | undefined;
    if (!editSnapToRoad) {
      if (detourViaPoints.length < 2) {
        setDetourPreviewCoords(waypoints);
        setEditRerouting(false);
        setEditRouteError('');
        return;
      }
      segModes = [
        'auto',
        ...Array<RouteSegmentMode>(detourViaPoints.length - 1).fill('direct'),
        'auto',
      ];
    }

    const seq = ++detourReqSeqRef.current;
    setEditRerouting(true);
    setEditRouteError('');
    void planRoute(routeMode, waypoints, routeProvider, segModes)
      .then((res) => {
        if (detourReqSeqRef.current !== seq) return;
        const seg = (res.geometry.coordinates as number[][]).map(([lng, lat]): [number, number] => [lng, lat]);
        setDetourPreviewCoords(seg);
      })
      .catch((err) => {
        if (detourReqSeqRef.current !== seq) return;
        setDetourPreviewCoords(null);
        setEditRouteError(extractErrorMessage(err).message);
      })
      .finally(() => {
        if (detourReqSeqRef.current === seq) {
          setEditRerouting(false);
        }
      });
  }, [editingLineFeatureId, editingLineCoords, detourWindow, detourViaPoints, editSnapToRoad, routeMode, routeProvider]);

  // 渲染局部换路预览（新路段高亮 + 可拖拽换路起终点 S/E + 可拖拽/删除必经点）
  useEffect(() => {
    const map = mapRef.current;
    for (const m of editLineMarkersRef.current) {
      m.remove();
    }
    editLineMarkersRef.current = [];
    if (!map || !editingLineFeatureId || editingLineCoords.length < 2) return;

    const src = map.getSource(DRAFT_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (src) {
      const displayFeatures: GeoJSON.Feature[] = [];
      const mergedPreview =
        detourWindow && detourPreviewCoords
          ? spliceLineSegment(editingLineCoords, detourWindow.startIdx, detourWindow.endIdx, detourPreviewCoords)
          : editingLineCoords;
      displayFeatures.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: mergedPreview.map(([lng, lat]) => wgs84ToDisplay(lng, lat, basemap)),
        },
        properties: {},
      });
      src.setData({ type: 'FeatureCollection', features: displayFeatures });
    }

    const markers: maplibregl.Marker[] = [];

    // 换路起点 S 与终点 E（可沿原折线拖动调整换路范围）
    if (detourWindow) {
      const endpoints: Array<{ kind: 'start' | 'end'; idx: number; label: string; bg: string }> = [
        { kind: 'start', idx: detourWindow.startIdx, label: '换路起点 S', bg: '#16a34a' },
        { kind: 'end', idx: detourWindow.endIdx, label: '换路终点 E', bg: '#dc2626' },
      ];
      for (const ep of endpoints) {
        const pt = editingLineCoords[ep.idx];
        if (!pt) continue;
        const wrap = document.createElement('div');
        wrap.style.display = 'flex';
        wrap.style.flexDirection = 'column';
        wrap.style.alignItems = 'center';
        wrap.style.cursor = 'grab';

        const tag = document.createElement('div');
        tag.className = 'measure-tag total';
        tag.style.background = ep.bg;
        tag.style.borderColor = '#ffffff';
        tag.style.marginBottom = '3px';
        tag.textContent = ep.label;
        wrap.appendChild(tag);

        const dot = document.createElement('span');
        dot.style.width = '14px';
        dot.style.height = '14px';
        dot.style.borderRadius = '50%';
        dot.style.background = ep.bg;
        dot.style.border = '2.5px solid #ffffff';
        dot.style.boxShadow = '0 2px 6px rgba(0,0,0,0.35)';
        wrap.appendChild(dot);

        const marker = new maplibregl.Marker({ element: wrap, draggable: true, anchor: 'bottom' })
          .setLngLat(wgs84ToDisplay(pt[0], pt[1], basemap))
          .addTo(map);

        marker.on('dragend', () => {
          const ll = marker.getLngLat();
          const [wLng, wLat] = displayToWgs84(ll.lng, ll.lat, latestRef.current.basemap);
          const { index: snappedIdx } = findNearestVertexIndex(editingLineCoords, [wLng, wLat]);
          setDetourManualRange(true);
          setDetourWindow((prev) => {
            if (!prev) return prev;
            if (ep.kind === 'start') {
              const nextStart = Math.min(snappedIdx, prev.endIdx - 1);
              return { startIdx: Math.max(0, nextStart), endIdx: prev.endIdx };
            }
            const nextEnd = Math.max(snappedIdx, prev.startIdx + 1);
            return { startIdx: prev.startIdx, endIdx: Math.min(editingLineCoords.length - 1, nextEnd) };
          });
        });
        markers.push(marker);
      }
    }

    // 必经途经点 Marker（可拖动微调、点击 × 删除）
    detourViaPoints.forEach((pt, idx) => {
      const wrap = document.createElement('div');
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.alignItems = 'center';
      wrap.style.cursor = 'grab';

      const pill = document.createElement('div');
      pill.className = 'measure-tag node';
      pill.style.pointerEvents = 'auto';
      pill.style.display = 'inline-flex';
      pill.style.alignItems = 'center';
      pill.style.gap = '4px';
      pill.style.marginBottom = '3px';
      pill.textContent = `必经 ${idx + 1}`;

      const delBtn = document.createElement('span');
      delBtn.textContent = '×';
      delBtn.style.cursor = 'pointer';
      delBtn.style.fontWeight = '700';
      delBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        setDetourViaPoints((prev) => prev.filter((_, i) => i !== idx));
      });
      pill.appendChild(delBtn);
      wrap.appendChild(pill);

      const dot = document.createElement('span');
      dot.style.width = '14px';
      dot.style.height = '14px';
      dot.style.borderRadius = '50%';
      dot.style.background = '#2563eb';
      dot.style.border = '2.5px solid #ffffff';
      dot.style.boxShadow = '0 2px 6px rgba(0,0,0,0.35)';
      wrap.appendChild(dot);

      const marker = new maplibregl.Marker({ element: wrap, draggable: true, anchor: 'bottom' })
        .setLngLat(wgs84ToDisplay(pt[0], pt[1], basemap))
        .addTo(map);

      marker.on('dragend', () => {
        const ll = marker.getLngLat();
        const [wLng, wLat] = displayToWgs84(ll.lng, ll.lat, latestRef.current.basemap);
        setDetourViaPoints((prev) =>
          prev.map((item, i) => (i === idx ? [Number(wLng.toFixed(6)), Number(wLat.toFixed(6))] : item)),
        );
      });
      markers.push(marker);
    });

    editLineMarkersRef.current = markers;
    return () => {
      for (const m of markers) m.remove();
    };
  }, [editingLineFeatureId, editingLineCoords, detourWindow, detourViaPoints, detourPreviewCoords, basemap]);

  // 键盘 ESC 退出绘制或测距
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && tool !== 'select') {
        setDraftCoords([]);
        setHoverCoord(null);
        setMeasureFrozen(false);
        onToolCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [tool, onToolCancel]);

  // 切换底图：保留已加载的 Source 缓存仅切 visibility，严格保留缩放/旋转/倾角，并换算中心坐标避免 CRS 偏移
  useEffect(() => {
    const map = mapRef.current;
    if (!map || prevBasemapRef.current === basemap) return;

    const curCenter = map.getCenter();
    const curZoom = map.getZoom();
    const curBearing = map.getBearing();
    const curPitch = map.getPitch();
    const [wLng, wLat] = displayToWgs84(curCenter.lng, curCenter.lat, prevBasemapRef.current);
    const nextDisplay = wgs84ToDisplay(wLng, wLat, basemap);
    prevBasemapRef.current = basemap;

    syncBasemapLayer(map, basemap);
    map.jumpTo({
      center: nextDisplay,
      zoom: curZoom,
      bearing: curBearing,
      pitch: curPitch,
    });
    syncOverlayLayer(map, basemap, latestRef.current.overlay);
    syncTrafficTileLayer(map, basemap, latestRef.current.showTraffic);
  }, [basemap]);

  // 切换路网叠加层（原地增删图层，不影响底图与视角）
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    syncOverlayLayer(map, latestRef.current.basemap, overlay);
  }, [overlay]);

  // 独立开关全图实时路况层（可与卫星底图+地名/路网叠加层同时开启）
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    syncTrafficTileLayer(map, latestRef.current.basemap, showTraffic);
  }, [showTraffic]);

  // 同步线/面 GeoJSON 数据与点 Marker
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const src = map.getSource(FEATURES_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (src) {
      src.setData(buildFeatureCollection(features, basemap, selectedFeatureId, viewportBounds));
    }

    for (const marker of markersRef.current.values()) {
      marker.remove();
    }
    markersRef.current.clear();
    const featureLabelEntries: typeof labelEntriesRef.current.features = [];

    features.forEach((f, idx) => {
      if (!f.visible || f.geometry.type !== 'Point') return;
      const [lng, lat] = f.geometry.coordinates as number[];
      const displayCoord = wgs84ToDisplay(lng, lat, basemap);
      const isSelected = f.id === selectedFeatureId;

      const el = document.createElement('div');
      el.style.position = 'relative';
      el.style.width = '0px';
      el.style.height = '0px';
      el.style.cursor = 'pointer';
      el.style.userSelect = 'none';
      el.style.zIndex = isSelected ? '12' : '3';

      const pinSize = isSelected ? 18 : 14;
      const pin = document.createElement('span');
      pin.style.position = 'absolute';
      pin.style.left = `${-pinSize / 2}px`;
      pin.style.top = `${-pinSize / 2}px`;
      pin.style.width = `${pinSize}px`;
      pin.style.height = `${pinSize}px`;
      pin.style.borderRadius = '50%';
      pin.style.background = f.color || '#2563eb';
      pin.style.border = isSelected ? '3px solid #0f172a' : '2.5px solid #ffffff';
      pin.style.boxShadow = '0 2px 6px rgba(0,0,0,0.35)';
      el.appendChild(pin);

      let labelEl: HTMLElement | null = null;
      if (f.title) {
        const label = document.createElement('span');
        label.textContent = f.title;
        label.style.position = 'absolute';
        label.style.background = isSelected ? '#0f172a' : 'rgba(255,255,255,0.92)';
        label.style.color = isSelected ? '#ffffff' : '#0f172a';
        label.style.padding = '2px 6px';
        label.style.borderRadius = '6px';
        label.style.fontSize = '12px';
        label.style.fontWeight = '600';
        label.style.boxShadow = '0 1px 4px rgba(0,0,0,0.2)';
        label.style.whiteSpace = 'nowrap';
        label.style.maxWidth = '160px';
        label.style.overflow = 'hidden';
        label.style.textOverflow = 'ellipsis';
        el.appendChild(label);
        labelEl = label;
      }

      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (latestRef.current.editingLineFeatureId) {
          setDetourViaPoints((prev) => [...prev, [Number(lng.toFixed(6)), Number(lat.toFixed(6))]]);
          return;
        }
        const curTool = latestRef.current.tool;
        if (curTool === 'select') {
          latestRef.current.onSelectFeature(f.id);
          return;
        }
        if (
          curTool === 'route' ||
          curTool === 'line' ||
          curTool === 'polygon' ||
          curTool === 'measure-distance' ||
          curTool === 'measure-area'
        ) {
          const snapped: [number, number] = [Number(lng.toFixed(6)), Number(lat.toFixed(6))];
          setDraftCoords((prev) => {
            const last = prev[prev.length - 1];
            if (last && Math.abs(last[0] - snapped[0]) < 1e-7 && Math.abs(last[1] - snapped[1]) < 1e-7) {
              return prev;
            }
            setDraftNames((names) => [...names, f.title || '']);
            if (curTool === 'route' && prev.length >= 1) {
              setRouteSegmentModes((modes) => [...modes, latestRef.current.defaultSegMode]);
            }
            return [...prev, snapped];
          });
        }
      });

      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat(displayCoord)
        .addTo(map);
      markersRef.current.set(f.id, marker);
      featureLabelEntries.push({
        id: `feature:${f.id}`,
        marker,
        tagEl: labelEl,
        displayCoord,
        labelText: f.title || '',
        pinRadius: pinSize / 2,
        priority: isSelected ? 1 : 100 + idx,
      });
    });

    labelEntriesRef.current.features = featureLabelEntries;
    relayoutMapLabels(map);
  }, [features, basemap, selectedFeatureId, viewportBounds]);

  // 同步绘制/测距/路线规划草图图层与图形标签
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (editingLineFeatureId) return;

    const activeHover = measureFrozen || tool === 'route' ? null : hoverCoord;
    const src = map.getSource(DRAFT_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (src) {
      src.setData(
        buildDraftCollection(
          draftCoords,
          activeHover,
          tool,
          basemap,
          routeResult?.geometry,
          routeResult?.traffic_segments,
          routeAvoidSegments,
        ),
      );
    }

    for (const label of draftLabelsRef.current) {
      label.remove();
    }
    draftLabelsRef.current = [];

    if (tool === 'route' && draftCoords.length > 0) {
      const nextLabels: maplibregl.Marker[] = [];

      // 可拖拽的途经点 Marker（拖动改路 + 点击 × 删除单个途经点）
      draftCoords.forEach((pt, idx) => {
        const isStart = idx === 0;
        const isEnd = idx === draftCoords.length - 1 && draftCoords.length >= 2;
        const name = draftNames[idx];
        const prefix = isStart ? '起点' : isEnd ? '终点' : `途经 ${idx}`;

        const wrap = document.createElement('div');
        wrap.style.display = 'flex';
        wrap.style.flexDirection = 'column';
        wrap.style.alignItems = 'center';
        wrap.style.cursor = 'grab';

        const pill = document.createElement('div');
        pill.className = isEnd ? 'measure-tag total' : 'measure-tag node';
        pill.style.pointerEvents = 'auto';
        pill.style.display = 'inline-flex';
        pill.style.alignItems = 'center';
        pill.style.gap = '4px';
        pill.style.marginBottom = '3px';
        pill.textContent = name ? `${prefix}: ${name}` : prefix;

        const delBtn = document.createElement('span');
        delBtn.textContent = '×';
        delBtn.style.cursor = 'pointer';
        delBtn.style.fontWeight = '700';
        delBtn.style.padding = '0 2px';
        delBtn.title = '移除该途经点';
        delBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          pushRouteHistory();
          setBypassState(null);
          setDraftCoords((prev) => prev.filter((_, i) => i !== idx));
          setDraftNames((prev) => prev.filter((_, i) => i !== idx));
          setRouteSegmentModes((modes) => {
            if (modes.length === 0) return modes;
            const removeSegIdx = idx === 0 ? 0 : idx - 1;
            return modes.filter((_, i) => i !== removeSegIdx);
          });
        });
        pill.appendChild(delBtn);
        wrap.appendChild(pill);

        const dot = document.createElement('span');
        dot.style.width = '14px';
        dot.style.height = '14px';
        dot.style.borderRadius = '50%';
        dot.style.background = isStart ? '#16a34a' : isEnd ? '#dc2626' : '#f59e0b';
        dot.style.border = '2.5px solid #ffffff';
        dot.style.boxShadow = '0 2px 6px rgba(0,0,0,0.35)';
        wrap.appendChild(dot);

        const marker = new maplibregl.Marker({ element: wrap, draggable: true, anchor: 'bottom' })
          .setLngLat(wgs84ToDisplay(pt[0], pt[1], basemap))
          .addTo(map);

        marker.on('dragend', () => {
          const ll = marker.getLngLat();
          const [wLng, wLat] = displayToWgs84(ll.lng, ll.lat, latestRef.current.basemap);
          pushRouteHistory();
          setBypassState(null);
          setDraftCoords((prev) =>
            prev.map((item, i) => (i === idx ? [Number(wLng.toFixed(6)), Number(wLat.toFixed(6))] : item)),
          );
          setDraftNames((prev) => prev.map((n, i) => (i === idx ? '' : n)));
        });
        nextLabels.push(marker);
      });

      // 每段中点放置独立策略切换徽章（驾车：智能/高速/国道/避堵/直线；骑行/徒步：贴路/直线）
      for (let i = 0; i < draftCoords.length - 1; i++) {
        const p1 = draftCoords[i];
        const p2 = draftCoords[i + 1];
        const mid: [number, number] = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
        const mode = routeSegmentModes[i] ?? 'auto';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = mode !== 'auto' ? 'measure-tag total' : 'measure-tag';
        btn.style.pointerEvents = 'auto';
        btn.style.cursor = 'pointer';
        btn.textContent = segmentModeLabel(mode, routeMode);
        btn.title = '点击切换此段策略';
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          pushRouteHistory();
          setBypassState(null);
          setRouteSegmentModes((prev) => {
            const next = [...prev];
            while (next.length < draftCoords.length - 1) next.push('auto');
            next[i] = nextSegmentMode(next[i], routeMode);
            return next;
          });
        });

        const segMarker = new maplibregl.Marker({ element: btn })
          .setLngLat(wgs84ToDisplay(mid[0], mid[1], basemap))
          .addTo(map);
        nextLabels.push(segMarker);
      }

      // 渲染驾车避开区 Marker（点击 × 移除）
      routeAvoidPoints.forEach((pt, idx) => {
        const tag = document.createElement('div');
        tag.className = 'measure-tag total';
        tag.style.pointerEvents = 'auto';
        tag.style.background = '#dc2626';
        tag.style.borderColor = '#ffffff';
        tag.style.display = 'inline-flex';
        tag.style.alignItems = 'center';
        tag.style.gap = '4px';
        tag.textContent = `避开 ${idx + 1}`;

        const delBtn = document.createElement('span');
        delBtn.textContent = '×';
        delBtn.style.cursor = 'pointer';
        delBtn.style.fontWeight = '700';
        delBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          pushRouteHistory();
          setBypassState(null);
          setRouteAvoidPoints((prev) => prev.filter((_, i) => i !== idx));
        });
        tag.appendChild(delBtn);

        const avoidMarker = new maplibregl.Marker({ element: tag })
          .setLngLat(wgs84ToDisplay(pt[0], pt[1], basemap))
          .addTo(map);
        nextLabels.push(avoidMarker);
      });

      // 渲染整段避开路中点标签（点击 × 移除）
      routeAvoidSegments.forEach((seg, idx) => {
        if (seg.length < 2) return;
        const mid = seg[Math.floor(seg.length / 2)];
        const tag = document.createElement('div');
        tag.className = 'measure-tag total';
        tag.style.pointerEvents = 'auto';
        tag.style.background = '#b91c1c';
        tag.style.borderColor = '#ffffff';
        tag.style.display = 'inline-flex';
        tag.style.alignItems = 'center';
        tag.style.gap = '4px';
        tag.textContent = `避开段 ${idx + 1}`;

        const delBtn = document.createElement('span');
        delBtn.textContent = '×';
        delBtn.style.cursor = 'pointer';
        delBtn.style.fontWeight = '700';
        delBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          pushRouteHistory();
          setBypassState(null);
          setRouteAvoidSegments((prev) => prev.filter((_, i) => i !== idx));
        });
        tag.appendChild(delBtn);

        const segMarker = new maplibregl.Marker({ element: tag })
          .setLngLat(wgs84ToDisplay(mid[0], mid[1], basemap))
          .addTo(map);
        nextLabels.push(segMarker);
      });

      draftLabelsRef.current = nextLabels;
      return;
    }

    const isLineLike = tool === 'line' || tool === 'measure-distance';
    const isPolyLike = tool === 'polygon' || tool === 'measure-area';
    if ((!isLineLike && !isPolyLike) || draftCoords.length === 0) return;

    const previewCoords = activeHover ? [...draftCoords, activeHover] : draftCoords;
    const nextLabels: maplibregl.Marker[] = [];

    if (isLineLike) {
      nextLabels.push(createMeasureMarker(map, previewCoords[0], basemap, '起点', 'node', [0, -16]));
      let cumulative = 0;
      for (let i = 1; i < previewCoords.length; i++) {
        const p1 = previewCoords[i - 1];
        const p2 = previewCoords[i];
        const segMeters = haversineMeters(p1[0], p1[1], p2[0], p2[1]);
        cumulative += segMeters;

        const mid: [number, number] = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
        if (segMeters >= 1) {
          nextLabels.push(createMeasureMarker(map, mid, basemap, formatDistance(segMeters), 'seg'));
        }

        const isLast = i === previewCoords.length - 1;
        if (isLast) {
          nextLabels.push(
            createMeasureMarker(map, p2, basemap, `总长 ${formatDistance(cumulative)}`, 'total', [0, -20]),
          );
        } else {
          nextLabels.push(createMeasureMarker(map, p2, basemap, formatDistance(cumulative), 'node', [0, -16]));
        }
      }
    } else if (isPolyLike) {
      const edgeCount = previewCoords.length >= 3 ? previewCoords.length : previewCoords.length - 1;
      for (let i = 0; i < edgeCount; i++) {
        const p1 = previewCoords[i];
        const p2 = previewCoords[(i + 1) % previewCoords.length];
        const segMeters = haversineMeters(p1[0], p1[1], p2[0], p2[1]);
        if (segMeters >= 1) {
          const mid: [number, number] = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
          nextLabels.push(createMeasureMarker(map, mid, basemap, formatDistance(segMeters), 'seg'));
        }
      }
      if (previewCoords.length >= 3) {
        const area = polygonAreaSqMeters(previewCoords);
        const cx = previewCoords.reduce((acc, p) => acc + p[0], 0) / previewCoords.length;
        const cy = previewCoords.reduce((acc, p) => acc + p[1], 0) / previewCoords.length;
        nextLabels.push(createMeasureMarker(map, [cx, cy], basemap, `面积 ${formatArea(area)}`, 'total'));
      }
    }

    draftLabelsRef.current = nextLabels;
  }, [draftCoords, draftNames, routeSegmentModes, routeAvoidPoints, routeAvoidSegments, routeMode, hoverCoord, measureFrozen, routeResult, editingLineFeatureId, tool, basemap]);

  // 飞行定位到目标 WGS-84 坐标或外接包围盒（仅在 flyTarget 变化时触发，切底图不重新飞转）
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !flyTarget) return;
    const curBasemap = latestRef.current.basemap;

    if (flyTarget.bounds) {
      const sw = wgs84ToDisplay(flyTarget.bounds[0][0], flyTarget.bounds[0][1], curBasemap);
      const ne = wgs84ToDisplay(flyTarget.bounds[1][0], flyTarget.bounds[1][1], curBasemap);
      const containerW = map.getContainer().clientWidth;
      const isMobile = containerW <= 768;
      const sidePad = isMobile ? 28 : containerW > 1100 ? 370 : Math.min(80, Math.round(containerW * 0.12));
      map.fitBounds([sw, ne], {
        padding: {
          top: isMobile ? 74 : 96,
          bottom: isMobile ? 110 : 72,
          left: sidePad,
          right: sidePad,
        },
        maxZoom: 16,
        duration: 700,
      });
      return;
    }

    const target = wgs84ToDisplay(flyTarget.lng, flyTarget.lat, curBasemap);
    map.flyTo({ center: target, zoom: flyTarget.zoom ?? Math.max(map.getZoom(), 14), duration: 700 });
  }, [flyTarget]);

  // 渲染用户当前位置蓝点（随底图自动做 WGS-84 / GCJ-02 纠偏）
  useEffect(() => {
    const map = mapRef.current;
    userMarkerRef.current?.remove();
    userMarkerRef.current = null;
    if (!map || !userLocation) return;

    const el = document.createElement('div');
    el.style.width = '16px';
    el.style.height = '16px';
    el.style.borderRadius = '50%';
    el.style.background = '#2563eb';
    el.style.border = '3px solid #ffffff';
    el.style.boxShadow = '0 0 0 6px rgba(37, 99, 235, 0.25), 0 2px 6px rgba(0, 0, 0, 0.3)';
    el.title = '当前位置';

    const displayCoord = wgs84ToDisplay(userLocation[0], userLocation[1], basemap);
    userMarkerRef.current = new maplibregl.Marker({ element: el }).setLngLat(displayCoord).addTo(map);
  }, [userLocation, basemap]);

  // 全量渲染搜索结果临时标记与当前高亮项边界预览（随底图自动做 WGS-84 / GCJ-02 纠偏）
  useEffect(() => {
    const map = mapRef.current;
    for (const m of searchMarkersRef.current) {
      m.remove();
    }
    searchMarkersRef.current = [];
    if (!map) return;

    const activePlace =
      activeSearchIndex !== null
        ? searchResults[activeSearchIndex] ?? null
        : searchResults.length === 1
          ? searchResults[0]
          : null;

    const src = map.getSource(PREVIEW_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (src) {
      if (activePlace?.boundary) {
        src.setData({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              geometry: geometryToDisplay(activePlace.boundary, basemap) as GeoJSON.Geometry,
              properties: {},
            },
          ],
        });
      } else {
        src.setData({ type: 'FeatureCollection', features: [] });
      }
    }

    if (searchResults.length === 0) {
      labelEntriesRef.current.search = [];
      relayoutMapLabels(map);
      return;
    }

    const nextMarkers: maplibregl.Marker[] = [];
    const searchLabelEntries: typeof labelEntriesRef.current.search = [];
    searchResults.forEach((place, idx) => {
      const isActive = idx === activeSearchIndex || (activeSearchIndex === null && searchResults.length === 1);
      const pinSize = isActive ? 24 : 20;

      const el = document.createElement('div');
      el.style.position = 'relative';
      el.style.width = '0px';
      el.style.height = '0px';
      el.style.cursor = 'pointer';
      el.style.userSelect = 'none';
      el.style.zIndex = isActive ? '15' : '5';

      const tag = document.createElement('div');
      tag.textContent = place.name;
      tag.style.position = 'absolute';
      tag.style.background = isActive ? '#dc2626' : 'rgba(255, 255, 255, 0.94)';
      tag.style.color = isActive ? '#ffffff' : '#991b1b';
      tag.style.border = isActive ? '1px solid #dc2626' : '1px solid rgba(220, 38, 38, 0.35)';
      tag.style.padding = isActive ? '3px 8px' : '2px 6px';
      tag.style.borderRadius = '999px';
      tag.style.fontSize = isActive ? '12px' : '11px';
      tag.style.fontWeight = '600';
      tag.style.boxShadow = isActive
        ? '0 2px 8px rgba(220, 38, 38, 0.42)'
        : '0 1px 4px rgba(15, 23, 42, 0.18)';
      tag.style.whiteSpace = 'nowrap';
      tag.style.maxWidth = '160px';
      tag.style.overflow = 'hidden';
      tag.style.textOverflow = 'ellipsis';
      el.appendChild(tag);

      const pin = document.createElement('span');
      pin.textContent = String(idx + 1);
      pin.style.position = 'absolute';
      pin.style.left = `${-pinSize / 2}px`;
      pin.style.top = `${-pinSize / 2}px`;
      pin.style.display = 'inline-flex';
      pin.style.alignItems = 'center';
      pin.style.justifyContent = 'center';
      pin.style.width = `${pinSize}px`;
      pin.style.height = `${pinSize}px`;
      pin.style.borderRadius = '50%';
      pin.style.background = isActive ? '#dc2626' : '#ef4444';
      pin.style.color = '#ffffff';
      pin.style.fontSize = isActive ? '12px' : '11px';
      pin.style.fontWeight = '700';
      pin.style.border = isActive ? '3px solid #ffffff' : '2px solid #ffffff';
      pin.style.boxShadow = isActive
        ? '0 0 0 6px rgba(220, 38, 38, 0.25), 0 2px 6px rgba(0, 0, 0, 0.35)'
        : '0 2px 5px rgba(0, 0, 0, 0.28)';
      el.appendChild(pin);

      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const curTool = latestRef.current.tool;
        if (curTool === 'route') {
          const snapped: [number, number] = [Number(place.lng.toFixed(6)), Number(place.lat.toFixed(6))];
          pushRouteHistory();
          setBypassState(null);
          setDraftCoords((prev) => {
            const last = prev[prev.length - 1];
            if (last && Math.abs(last[0] - snapped[0]) < 1e-7 && Math.abs(last[1] - snapped[1]) < 1e-7) {
              return prev;
            }
            setDraftNames((names) => [...names, place.name || '']);
            if (prev.length >= 1) {
              setRouteSegmentModes((modes) => [...modes, latestRef.current.defaultSegMode]);
            }
            return [...prev, snapped];
          });
          return;
        }
        latestRef.current.onSelectSearchResult?.(idx);
      });

      const displayCoord = wgs84ToDisplay(place.lng, place.lat, basemap);
      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat(displayCoord)
        .addTo(map);
      nextMarkers.push(marker);
      searchLabelEntries.push({
        id: `search:${idx}`,
        marker,
        tagEl: tag,
        displayCoord,
        labelText: place.name,
        pinRadius: pinSize / 2,
        priority: isActive ? 0 : 10 + idx,
      });
    });
    searchMarkersRef.current = nextMarkers;
    labelEntriesRef.current.search = searchLabelEntries;
    relayoutMapLabels(map);
  }, [searchResults, activeSearchIndex, basemap]);

  // 渲染贝壳找房小区聚合气泡（带价格与套数，纳入统一防重叠排布）
  useEffect(() => {
    const map = mapRef.current;
    for (const m of beikeMarkersRef.current) {
      m.remove();
    }
    beikeMarkersRef.current = [];
    if (!map) return;

    if (beikeClusters.length === 0) {
      labelEntriesRef.current.beike = [];
      relayoutMapLabels(map);
      return;
    }

    const liquidityColors = {
      hot: {
        bg: 'rgba(236, 253, 245, 0.96)',
        text: '#065f46',
        border: 'rgba(5, 150, 105, 0.45)',
        pin: '#10b981',
        activeBg: '#047857',
        shadow: 'rgba(4, 120, 87, 0.42)',
        ring: 'rgba(16, 185, 129, 0.25)',
      },
      normal: {
        bg: 'rgba(255, 251, 235, 0.96)',
        text: '#92400e',
        border: 'rgba(217, 119, 6, 0.45)',
        pin: '#f59e0b',
        activeBg: '#b45309',
        shadow: 'rgba(180, 83, 9, 0.42)',
        ring: 'rgba(245, 158, 11, 0.28)',
      },
      slow: {
        bg: 'rgba(238, 242, 255, 0.96)',
        text: '#3730a3',
        border: 'rgba(99, 102, 241, 0.45)',
        pin: '#6366f1',
        activeBg: '#4338ca',
        shadow: 'rgba(67, 56, 202, 0.42)',
        ring: 'rgba(99, 102, 241, 0.25)',
      },
      unknown: {
        bg: 'rgba(248, 250, 252, 0.96)',
        text: '#334155',
        border: 'rgba(100, 116, 139, 0.42)',
        pin: '#64748b',
        activeBg: '#334155',
        shadow: 'rgba(51, 65, 85, 0.4)',
        ring: 'rgba(100, 116, 139, 0.25)',
      },
    } as const;

    const nextMarkers: maplibregl.Marker[] = [];
    const beikeLabelEntries: typeof labelEntriesRef.current.beike = [];
    beikeClusters.forEach((cluster, idx) => {
      const isActive = cluster.key === activeBeikeClusterKey;
      const pinSize = isActive ? 22 : 18;
      const palette = liquidityColors[cluster.liquidity];

      const el = document.createElement('div');
      el.style.position = 'relative';
      el.style.width = '0px';
      el.style.height = '0px';
      el.style.cursor = 'pointer';
      el.style.userSelect = 'none';
      el.style.zIndex = isActive ? '16' : '6';

      const priceText = cluster.minPrice > 0 ? `¥${Math.round(cluster.minPrice)}起` : '面议';
      const daysPart = cluster.medianListedDays !== null ? ` · ${cluster.medianListedDays}天` : '';
      const labelText = `${cluster.resblock} · ${priceText} (${cluster.houses.length}套${daysPart})`;

      const tag = document.createElement('div');
      tag.textContent = labelText;
      tag.style.position = 'absolute';
      tag.style.background = isActive ? palette.activeBg : palette.bg;
      tag.style.color = isActive ? '#ffffff' : palette.text;
      tag.style.border = isActive ? `1px solid ${palette.activeBg}` : `1px solid ${palette.border}`;
      tag.style.padding = isActive ? '3px 8px' : '2px 7px';
      tag.style.borderRadius = '999px';
      tag.style.fontSize = isActive ? '12px' : '11px';
      tag.style.fontWeight = '600';
      tag.style.boxShadow = isActive
        ? `0 2px 10px ${palette.shadow}`
        : '0 1px 4px rgba(15, 23, 42, 0.16)';
      tag.style.whiteSpace = 'nowrap';
      tag.style.maxWidth = '230px';
      tag.style.overflow = 'hidden';
      tag.style.textOverflow = 'ellipsis';
      el.appendChild(tag);

      const pin = document.createElement('span');
      pin.textContent = String(cluster.houses.length);
      pin.style.position = 'absolute';
      pin.style.left = `${-pinSize / 2}px`;
      pin.style.top = `${-pinSize / 2}px`;
      pin.style.display = 'inline-flex';
      pin.style.alignItems = 'center';
      pin.style.justifyContent = 'center';
      pin.style.width = `${pinSize}px`;
      pin.style.height = `${pinSize}px`;
      pin.style.borderRadius = '50%';
      pin.style.background = isActive ? palette.activeBg : palette.pin;
      pin.style.color = '#ffffff';
      pin.style.fontSize = '11px';
      pin.style.fontWeight = '700';
      pin.style.border = isActive ? '3px solid #ffffff' : '2px solid #ffffff';
      pin.style.boxShadow = isActive
        ? `0 0 0 6px ${palette.ring}, 0 2px 6px rgba(0, 0, 0, 0.35)`
        : '0 2px 5px rgba(0, 0, 0, 0.26)';
      el.appendChild(pin);

      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        latestRef.current.onSelectBeikeCluster?.(cluster.key);
      });

      const displayCoord = wgs84ToDisplay(cluster.lng, cluster.lat, basemap);
      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat(displayCoord)
        .addTo(map);
      nextMarkers.push(marker);
      beikeLabelEntries.push({
        id: `beike:${cluster.key}`,
        marker,
        tagEl: tag,
        displayCoord,
        labelText,
        pinRadius: pinSize / 2,
        priority: isActive ? 0 : 40 + idx,
      });
    });

    beikeMarkersRef.current = nextMarkers;
    labelEntriesRef.current.beike = beikeLabelEntries;
    relayoutMapLabels(map);
  }, [beikeClusters, activeBeikeClusterKey, basemap]);

  // 渲染已保存路线的按需实时路况叠层
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const src = map.getSource(TRAFFIC_OVERLAY_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;

    if (!trafficOverlay || trafficOverlay.length === 0) {
      src.setData({ type: 'FeatureCollection', features: [] });
      return;
    }

    src.setData({
      type: 'FeatureCollection',
      features: trafficOverlay
        .filter((seg) => seg.coordinates.length >= 2)
        .map((seg) => ({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: seg.coordinates.map(([lng, lat]) => wgs84ToDisplay(lng, lat, basemap)),
          },
          properties: { color: seg.color, status: seg.status },
        })),
    });
  }, [trafficOverlay, basemap]);

  function finishDraft() {
    const { draftCoords: coords, tool: curTool, onCreateGeometry: createCb } = latestRef.current;
    if (curTool === 'line' && coords.length >= 2) {
      createCb({ type: 'LineString', coordinates: coords });
      setDraftCoords([]);
      setHoverCoord(null);
    } else if (curTool === 'polygon' && coords.length >= 3) {
      createCb({ type: 'Polygon', coordinates: [[...coords, coords[0]]] });
      setDraftCoords([]);
      setHoverCoord(null);
    }
  }

  function renderDraftBanner() {
    if (editingLineFeatureId) {
      const mergedPreview =
        detourWindow && detourPreviewCoords
          ? spliceLineSegment(editingLineCoords, detourWindow.startIdx, detourWindow.endIdx, detourPreviewCoords)
          : editingLineCoords;
      return (
        <div className="draw-banner">
          <button
            className={`btn ${routeMode === 'driving' ? 'primary' : ''}`}
            onClick={() => setRouteMode('driving')}
          >
            驾车
          </button>
          <button
            className={`btn ${routeMode === 'bicycling' ? 'primary' : ''}`}
            onClick={() => setRouteMode('bicycling')}
          >
            骑行
          </button>
          <button
            className={`btn ${routeMode === 'walking' ? 'primary' : ''}`}
            onClick={() => setRouteMode('walking')}
          >
            徒步
          </button>
          <button
            className={`btn ${!editSnapToRoad ? 'primary' : ''}`}
            onClick={() => setEditSnapToRoad((v) => !v)}
            title="全段贴路，或仅必经点之间走直线（如穿隧道/捷径）且两端仍贴路"
          >
            {editSnapToRoad ? '全段贴路' : '必经段直线'}
          </button>
          <select
            className="select-input"
            style={{ background: '#1e293b', color: '#fff', borderColor: '#475569', padding: '3px 6px', fontSize: 12 }}
            value={routeProvider}
            onChange={(e) => setRouteProvider(e.target.value as RouteProvider)}
          >
            <option value="auto">自动源</option>
            <option value="amap">高德</option>
            <option value="osrm">OSRM</option>
          </select>
          <span>
            {detourViaPoints.length === 0
              ? `点击地图或标注点添加必经点（总长 ${formatDistance(lineLengthMeters(editingLineCoords))}）`
              : editRerouting
                ? '正在局部换路...'
                : editRouteError
                  ? `换路失败：${editRouteError}`
                  : `已加 ${detourViaPoints.length} 个必经点 · 拖动 S/E 可调换路范围 · 预览总长 ${formatDistance(lineLengthMeters(mergedPreview))}`}
          </span>
          {detourWindow && detourPreviewCoords && !editRerouting && (
            <button
              className="btn primary"
              onClick={() => {
                setEditingLineCoords(mergedPreview);
                setDetourViaPoints([]);
                setDetourWindow(null);
                setDetourManualRange(false);
                setDetourPreviewCoords(null);
              }}
            >
              应用换路
            </button>
          )}
          {detourViaPoints.length > 0 && (
            <button
              className="btn"
              onClick={() => {
                setDetourViaPoints([]);
                setDetourWindow(null);
                setDetourManualRange(false);
                setDetourPreviewCoords(null);
              }}
            >
              重选
            </button>
          )}
          <button
            className="btn primary"
            disabled={editRerouting}
            onClick={() => onSaveEditedLine(editingLineFeatureId, mergedPreview)}
          >
            保存路线
          </button>
          <button className="btn" onClick={onCancelEditLine}>
            取消
          </button>
        </div>
      );
    }

    if (tool === 'select') return null;
    if (tool === 'point') {
      return (
        <div className="draw-banner">
          <span>点击地图任意位置添加点标注</span>
          <button className="btn" onClick={onToolCancel}>
            退出 (ESC)
          </button>
        </div>
      );
    }

    if (tool === 'route') {
      return (
        <>
        <div className="draw-banner">
          <button
            className={`btn ${routeMode === 'driving' ? 'primary' : ''}`}
            onClick={() => setRouteMode('driving')}
          >
            驾车
          </button>
          <button
            className={`btn ${routeMode === 'bicycling' ? 'primary' : ''}`}
            onClick={() => {
              setRouteMode('bicycling');
              setPickingAvoidPoint(false);
            }}
          >
            骑行
          </button>
          <button
            className={`btn ${routeMode === 'walking' ? 'primary' : ''}`}
            onClick={() => {
              setRouteMode('walking');
              setPickingAvoidPoint(false);
            }}
          >
            徒步
          </button>
          {routeMode === 'driving' ? (
            <>
              <select
                className="select-input"
                style={{ background: '#1e293b', color: '#fff', borderColor: '#475569', padding: '3px 6px', fontSize: 12 }}
                value={defaultSegMode}
                onChange={(e) => setDefaultSegMode(e.target.value as RouteSegmentMode)}
                title="新添加路段的默认驾车策略（每段中点也可独立切换）"
              >
                <option value="auto">新段: 智能</option>
                <option value="highway">新段: 高速优先</option>
                <option value="national">新段: 国道/不走高速</option>
                <option value="avoid-jam">新段: 躲避拥堵</option>
                <option value="direct">新段: 直线</option>
              </select>
              <button
                className={`btn ${pickingAvoidPoint ? 'primary' : ''}`}
                style={pickingAvoidPoint ? { background: '#dc2626' } : undefined}
                onClick={() => setPickingAvoidPoint((v) => !v)}
                title="开启后点击红/黄路况段可避开整段路，点击空白处可避开单点"
              >
                {pickingAvoidPoint
                  ? '点路况段或地图标记避开中...'
                  : `避开${
                      routeAvoidPoints.length + routeAvoidSegments.length > 0
                        ? `(${routeAvoidPoints.length + routeAvoidSegments.length})`
                        : '路段/点'
                    }`}
              </button>
              <button
                className={`btn ${smartBypassEnabled ? 'primary' : ''}`}
                onClick={() => setSmartBypassEnabled((v) => !v)}
                title="关闭：仅走高德官方避堵 API；开启：点拥堵段时自动搜附近收费站拆为高速+国道接力"
              >
                {smartBypassEnabled ? '智能拆段: 开' : '智能拆段: 关'}
              </button>
            </>
          ) : (
            <button
              className={`btn ${defaultSegMode === 'direct' ? 'primary' : ''}`}
              onClick={() => setDefaultSegMode((m) => (m === 'auto' ? 'direct' : 'auto'))}
              title="新添加路段的默认方式：贴路规划或自由直线（也可点每段中点单独切换）"
            >
              {defaultSegMode === 'direct' ? '新段: 直线' : '新段: 贴路'}
            </button>
          )}
          <select
            className="select-input"
            style={{ background: '#1e293b', color: '#fff', borderColor: '#475569', padding: '3px 6px', fontSize: 12 }}
            value={routeProvider}
            onChange={(e) => setRouteProvider(e.target.value as RouteProvider)}
            title="切换路径规划数据源"
          >
            <option value="auto">自动源</option>
            <option value="amap">高德</option>
            <option value="osrm">OSRM(绿道/野路)</option>
          </select>
          <span>
            {draftCoords.length < 2
              ? draftCoords.length === 0
                ? '点击地图或标注点选起点'
                : '点终点（每段中点可切高速/国道）'
              : routeLoading
                ? '正在规划路线...'
                : routeError
                  ? `规划失败：${routeError}`
                  : routeResult
                    ? `${formatDistance(routeResult.distance_meters)} · 约 ${formatDuration(routeResult.duration_seconds)}${
                        routeResult.legs && routeResult.legs.length > 1 ? ` · 拆为 ${routeResult.legs.length} 段导航` : ''
                      } (${routeResult.provider.toUpperCase()})`
                    : ''}
          </span>
          {routeResult?.traffic_segments && routeResult.traffic_segments.length > 0 && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11,
                opacity: 0.9,
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              <span style={{ color: '#4ade80' }}>●畅通</span>
              <span style={{ color: '#fbbf24' }}>●缓行</span>
              <span style={{ color: '#f87171' }}>●拥堵</span>
            </span>
          )}
          {routeHistory.length > 0 && (
            <button
              className="btn"
              onClick={undoRouteStep}
              title="撤销上一步操作 (Ctrl/Cmd+Z)"
            >
              撤销
            </button>
          )}
          {canEdit && routeResult && (
            <button
              className="btn primary"
              onClick={() => {
                onSaveRoute(routeResult, draftNames);
                setDraftCoords([]);
                setDraftNames([]);
                setRouteSegmentModes([]);
                setRouteAvoidPoints([]);
                setRouteAvoidSegments([]);
                setRouteHistory([]);
                setPickingAvoidPoint(false);
                setBypassLoading(false);
                setBypassState(null);
                setRouteResult(null);
              }}
            >
              保存路线
            </button>
          )}
          {(draftCoords.length > 0 || routeAvoidPoints.length > 0 || routeAvoidSegments.length > 0) && (
            <button
              className="btn"
              onClick={() => {
                pushRouteHistory();
                setDraftCoords([]);
                setDraftNames([]);
                setRouteSegmentModes([]);
                setRouteAvoidPoints([]);
                setRouteAvoidSegments([]);
                setPickingAvoidPoint(false);
                setBypassLoading(false);
                setBypassState(null);
                setRouteResult(null);
                setRouteError('');
              }}
            >
              清空
            </button>
          )}
          <button className="btn" onClick={onToolCancel}>
            退出
          </button>
        </div>
        {(bypassLoading || bypassState) && (
          <div className="bypass-compare-bar">
            {bypassLoading ? (
              <span>正在搜沿线收费站并实测多方案耗时...</span>
            ) : (
              bypassState && (
                <>
                  <span style={{ color: '#93c5fd', fontWeight: 600 }}>{bypassState.summary}</span>
                  {bypassState.options.map((opt) => (
                    <button
                      key={opt.id}
                      className={`btn ${bypassState.activeId === opt.id ? 'primary' : ''}`}
                      onClick={() => {
                        applyBypassOption(bypassState, opt);
                        setBypassState((prev) => (prev ? { ...prev, activeId: opt.id } : prev));
                      }}
                      title={opt.summary}
                    >
                      {opt.summary}
                    </button>
                  ))}
                  <button
                    className="btn"
                    onClick={() => setBypassState(null)}
                    title="关闭对比条"
                  >
                    ×
                  </button>
                </>
              )
            )}
          </div>
        )}
        </>
      );
    }

    const previewCoords = !measureFrozen && hoverCoord && draftCoords.length > 0 ? [...draftCoords, hoverCoord] : draftCoords;
    const isMeasure = tool === 'measure-distance' || tool === 'measure-area';
    const isPoly = tool === 'polygon' || tool === 'measure-area';
    const dist = isPoly && previewCoords.length >= 3
      ? lineLengthMeters([...previewCoords, previewCoords[0]])
      : lineLengthMeters(previewCoords);
    const area = previewCoords.length >= 3 ? polygonAreaSqMeters(previewCoords) : 0;

    return (
      <div className="draw-banner">
        <span>
          {isPoly
            ? `已选 ${draftCoords.length} 点 · 面积 ${formatArea(area)} · 周长 ${formatDistance(dist)}`
            : `已选 ${draftCoords.length} 点 · 总长 ${formatDistance(dist)}`}
          {isMeasure && !measureFrozen && draftCoords.length >= 2 ? '（双击锁定）' : ''}
        </span>
        {draftCoords.length > 0 && (
          <button
            className="btn"
            onClick={() => {
              setMeasureFrozen(false);
              setDraftCoords((prev) => prev.slice(0, -1));
            }}
          >
            撤销一点
          </button>
        )}
        {!isMeasure && ((tool === 'line' && draftCoords.length >= 2) || (tool === 'polygon' && draftCoords.length >= 3)) && (
          <button className="btn primary" onClick={finishDraft}>
            完成绘制
          </button>
        )}
        {isMeasure && draftCoords.length > 0 && (
          <button
            className="btn"
            onClick={() => {
              setDraftCoords([]);
              setHoverCoord(null);
              setMeasureFrozen(false);
            }}
          >
            清空
          </button>
        )}
        <button className="btn" onClick={onToolCancel}>
          退出
        </button>
      </div>
    );
  }

  return (
    <>
      <div ref={containerRef} className="map-container" />
      {beikeClusters.length > 0 && (
        <div className="beike-map-legend" title="按小区房源中位挂牌天数着色">
          <span className="beike-legend-item">
            <span className="beike-legend-dot" style={{ background: '#10b981' }} />
            ≤14天 热租
          </span>
          <span className="beike-legend-item">
            <span className="beike-legend-dot" style={{ background: '#f59e0b' }} />
            15-45天 正常
          </span>
          <span className="beike-legend-item">
            <span className="beike-legend-dot" style={{ background: '#6366f1' }} />
            &gt;45天 易议价
          </span>
        </div>
      )}
      {renderDraftBanner()}
    </>
  );
}
