import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { extractErrorMessage, planRoute } from '../api/client';
import { ensureAlignedTileProtocol } from '../map/alignedProtocol';
import {
  BASEMAPS,
  OVERLAYS,
  displayToWgs84,
  formatArea,
  formatDistance,
  geometryToDisplay,
  haversineMeters,
  isViewportInsidePolygon,
  lineLengthMeters,
  polygonAreaSqMeters,
  wgs84ToDisplay,
  type WgsBounds,
} from '../map/geo';
import type {
  BasemapId,
  DrawTool,
  GeoGeometry,
  MapFeature,
  OverlayId,
  PlaceResult,
  RouteMode,
  RouteResult,
} from '../types/map';

interface MapCanvasProps {
  basemap: BasemapId;
  overlay: OverlayId;
  canEdit: boolean;
  initialCenter: [number, number];
  initialZoom: number;
  features: MapFeature[];
  selectedFeatureId: string | null;
  searchPreview: PlaceResult | null;
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
  onCreateGeometry: (geometry: GeoGeometry) => void;
  onSaveRoute: (route: RouteResult, waypointNames: string[]) => void;
  onToolCancel: () => void;
  onViewChange?: (view: { lng: number; lat: number; zoom: number }) => void;
}

const FEATURES_SOURCE = 'little-map-features';
const DRAFT_SOURCE = 'little-map-draft';
const PREVIEW_SOURCE = 'little-map-search-preview';
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

// 切换底图时保留已加载的 Source 与 MapLibre 瓦片内存缓存，仅切换 visibility。
function syncBasemapLayer(map: maplibregl.Map, basemap: BasemapId) {
  const style = map.getStyle();
  if (!style) return;

  const targetLayer = basemapLayerId(basemap);
  for (const layer of style.layers ?? []) {
    if (layer.id.startsWith(BASEMAP_LAYER_PREFIX) && layer.id !== targetLayer) {
      map.setLayoutProperty(layer.id, 'visibility', 'none');
    }
  }

  if (map.getLayer(targetLayer)) {
    map.setLayoutProperty(targetLayer, 'visibility', 'visible');
    return;
  }

  const cfg = BASEMAPS[basemap] ?? BASEMAPS['amap-vec'];
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

  const firstLayerId = map.getStyle()?.layers?.[0]?.id;
  map.addLayer(
    {
      id: targetLayer,
      type: 'raster',
      source: srcId,
    },
    firstLayerId,
  );
}

// 切换路网叠加层时保留已加载的 Source，仅切换 visibility，始终位于底图之上、标注之下。
function syncOverlayLayer(map: maplibregl.Map, basemap: BasemapId, overlay: OverlayId) {
  const style = map.getStyle();
  if (!style) return;

  const baseCfg = BASEMAPS[basemap] ?? BASEMAPS['amap-vec'];
  const targetLayer = overlay === 'none' ? '' : overlayLayerId(overlay, baseCfg.crs);

  for (const layer of style.layers ?? []) {
    if (layer.id.startsWith(OVERLAY_LAYER_PREFIX) && layer.id !== targetLayer) {
      map.setLayoutProperty(layer.id, 'visibility', 'none');
    }
  }

  if (overlay === 'none') return;

  if (map.getLayer(targetLayer)) {
    map.setLayoutProperty(targetLayer, 'visibility', 'visible');
    return;
  }

  const ovCfg = OVERLAYS[overlay];
  if (!ovCfg || ovCfg.tiles.length === 0) return;

  const srcId = overlaySourceId(overlay, baseCfg.crs);
  if (!map.getSource(srcId)) {
    const tiles =
      baseCfg.crs === ovCfg.crs
        ? ovCfg.tiles
        : [`aligned-tile://${overlay}/${baseCfg.crs}/{z}/{x}/{y}`];

    map.addSource(srcId, {
      type: 'raster',
      tiles,
      tileSize: 256,
      maxzoom: ovCfg.maxzoom,
    });
  }

  const beforeId = map.getLayer('features-fill') ? 'features-fill' : undefined;
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
): GeoJSON.FeatureCollection {
  if (draftCoords.length === 0) {
    return { type: 'FeatureCollection', features: [] };
  }

  const fixedDisplay = draftCoords.map(([lng, lat]) => wgs84ToDisplay(lng, lat, basemap));
  const out: GeoJSON.Feature[] = fixedDisplay.map((coord) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: coord },
    properties: {},
  }));

  if (tool === 'route') {
    if (routeGeometry) {
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
  canEdit,
  initialCenter,
  initialZoom,
  features,
  selectedFeatureId,
  searchPreview,
  tool,
  flyTarget,
  userLocation,
  externalWaypoint,
  onSelectFeature,
  onCreateGeometry,
  onSaveRoute,
  onToolCancel,
  onViewChange,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<Map<string, maplibregl.Marker>>(new Map());
  const draftLabelsRef = useRef<maplibregl.Marker[]>([]);
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const previewMarkerRef = useRef<maplibregl.Marker | null>(null);
  const prevBasemapRef = useRef<BasemapId>(basemap);
  const routeReqSeqRef = useRef(0);

  const [draftCoords, setDraftCoords] = useState<[number, number][]>([]);
  const [draftNames, setDraftNames] = useState<string[]>([]);
  const [hoverCoord, setHoverCoord] = useState<[number, number] | null>(null);
  const [measureFrozen, setMeasureFrozen] = useState(false);
  const [viewportBounds, setViewportBounds] = useState<WgsBounds | null>(null);
  const [routeMode, setRouteMode] = useState<RouteMode>('bicycling');
  const [routeResult, setRouteResult] = useState<RouteResult | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState('');

  const latestRef = useRef({
    basemap,
    overlay,
    features,
    selectedFeatureId,
    searchPreview,
    viewportBounds,
    tool,
    draftCoords,
    hoverCoord,
    measureFrozen,
    onSelectFeature,
    onCreateGeometry,
    onViewChange,
  });
  latestRef.current = {
    basemap,
    overlay,
    features,
    selectedFeatureId,
    searchPreview,
    viewportBounds,
    tool,
    draftCoords,
    hoverCoord,
    measureFrozen,
    onSelectFeature,
    onCreateGeometry,
    onViewChange,
  };

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
        filter: ['in', '$type', 'LineString', 'Polygon'],
        paint: {
          'line-color': '#f59e0b',
          'line-width': 3,
          'line-dasharray': [2, 1.5],
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
      const preview = latestRef.current.searchPreview;
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
  }

  // 初始化 MapLibre 实例
  useEffect(() => {
    if (!containerRef.current) return;
    ensureAlignedTileProtocol();

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
      const sw = displayToWgs84(b.getWest(), b.getSouth(), latestRef.current.basemap);
      const ne = displayToWgs84(b.getEast(), b.getNorth(), latestRef.current.basemap);
      setViewportBounds([sw, ne]);
    };

    map.on('style.load', () => {
      ensureVectorLayers(map);
      syncOverlayLayer(map, latestRef.current.basemap, latestRef.current.overlay);
      updateViewportBounds();
    });

    map.on('click', (ev) => {
      const { tool: curTool, basemap: curBasemap, onSelectFeature: selCb, onCreateGeometry: createCb } =
        latestRef.current;

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

      setDraftCoords((prev) => {
        const last = prev[prev.length - 1];
        if (last && Math.abs(last[0] - nextPt[0]) < 1e-7 && Math.abs(last[1] - nextPt[1]) < 1e-7) {
          return prev;
        }
        setDraftNames((names) => [...names, '']);
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

    return () => {
      for (const marker of markersRef.current.values()) {
        marker.remove();
      }
      markersRef.current.clear();
      for (const label of draftLabelsRef.current) {
        label.remove();
      }
      draftLabelsRef.current = [];
      userMarkerRef.current?.remove();
      userMarkerRef.current = null;
      previewMarkerRef.current?.remove();
      previewMarkerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切换工具时清空未完成草图并更新光标样式
  useEffect(() => {
    setDraftCoords([]);
    setDraftNames([]);
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

  // 接收来自侧边栏点选的已有标注点作为规划途经点
  useEffect(() => {
    if (!externalWaypoint || tool !== 'route') return;
    const pt: [number, number] = [
      Number(externalWaypoint.coord[0].toFixed(6)),
      Number(externalWaypoint.coord[1].toFixed(6)),
    ];
    setDraftCoords((prev) => {
      const last = prev[prev.length - 1];
      if (last && Math.abs(last[0] - pt[0]) < 1e-7 && Math.abs(last[1] - pt[1]) < 1e-7) {
        return prev;
      }
      setDraftNames((names) => [...names, externalWaypoint.name ?? '']);
      return [...prev, pt];
    });
  }, [externalWaypoint, tool]);

  // 规划模式下途经点 >= 2 时自动请求骑行/徒步路线
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

    void planRoute(routeMode, draftCoords)
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
  }, [tool, routeMode, draftCoords]);

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
  }, [basemap]);

  // 切换路网叠加层（原地增删图层，不影响底图与视角）
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    syncOverlayLayer(map, latestRef.current.basemap, overlay);
  }, [overlay]);

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

    for (const f of features) {
      if (!f.visible || f.geometry.type !== 'Point') continue;
      const [lng, lat] = f.geometry.coordinates as number[];
      const displayCoord = wgs84ToDisplay(lng, lat, basemap);
      const isSelected = f.id === selectedFeatureId;

      const el = document.createElement('div');
      el.style.display = 'flex';
      el.style.alignItems = 'center';
      el.style.gap = '4px';
      el.style.cursor = 'pointer';
      el.style.userSelect = 'none';

      const pin = document.createElement('span');
      pin.style.width = isSelected ? '18px' : '14px';
      pin.style.height = isSelected ? '18px' : '14px';
      pin.style.borderRadius = '50%';
      pin.style.background = f.color || '#2563eb';
      pin.style.border = isSelected ? '3px solid #0f172a' : '2.5px solid #ffffff';
      pin.style.boxShadow = '0 2px 6px rgba(0,0,0,0.35)';
      el.appendChild(pin);

      if (f.title) {
        const label = document.createElement('span');
        label.textContent = f.title;
        label.style.background = isSelected ? '#0f172a' : 'rgba(255,255,255,0.92)';
        label.style.color = isSelected ? '#ffffff' : '#0f172a';
        label.style.padding = '2px 6px';
        label.style.borderRadius = '6px';
        label.style.fontSize = '12px';
        label.style.fontWeight = '600';
        label.style.boxShadow = '0 1px 4px rgba(0,0,0,0.2)';
        label.style.whiteSpace = 'nowrap';
        el.appendChild(label);
      }

      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
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
            return [...prev, snapped];
          });
        }
      });

      const marker = new maplibregl.Marker({ element: el, anchor: 'left' })
        .setLngLat(displayCoord)
        .addTo(map);
      markersRef.current.set(f.id, marker);
    }
  }, [features, basemap, selectedFeatureId, viewportBounds]);

  // 同步绘制/测距/路线规划草图图层与图形标签
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const activeHover = measureFrozen || tool === 'route' ? null : hoverCoord;
    const src = map.getSource(DRAFT_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (src) {
      src.setData(buildDraftCollection(draftCoords, activeHover, tool, basemap, routeResult?.geometry));
    }

    for (const label of draftLabelsRef.current) {
      label.remove();
    }
    draftLabelsRef.current = [];

    if (tool === 'route' && draftCoords.length > 0) {
      const nextLabels: maplibregl.Marker[] = [];
      draftCoords.forEach((pt, idx) => {
        const isStart = idx === 0;
        const isEnd = idx === draftCoords.length - 1 && draftCoords.length >= 2;
        const name = draftNames[idx];
        const prefix = isStart ? '起点' : isEnd ? '终点' : `途经 ${idx}`;
        const tag = name ? `${prefix}: ${name}` : prefix;
        nextLabels.push(createMeasureMarker(map, pt, basemap, tag, isEnd ? 'total' : 'node', [0, -18]));
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
  }, [draftCoords, draftNames, hoverCoord, measureFrozen, routeResult, tool, basemap]);

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

  // 渲染搜索结果临时高亮标记与边界预览（随底图自动做 WGS-84 / GCJ-02 纠偏）
  useEffect(() => {
    const map = mapRef.current;
    previewMarkerRef.current?.remove();
    previewMarkerRef.current = null;
    if (!map) return;

    const src = map.getSource(PREVIEW_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (src) {
      if (searchPreview?.boundary) {
        src.setData({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              geometry: geometryToDisplay(searchPreview.boundary, basemap) as GeoJSON.Geometry,
              properties: {},
            },
          ],
        });
      } else {
        src.setData({ type: 'FeatureCollection', features: [] });
      }
    }

    if (!searchPreview) return;

    const el = document.createElement('div');
    el.style.display = 'flex';
    el.style.flexDirection = 'column';
    el.style.alignItems = 'center';
    el.style.pointerEvents = 'none';

    const tag = document.createElement('div');
    tag.textContent = searchPreview.name;
    tag.style.background = '#dc2626';
    tag.style.color = '#ffffff';
    tag.style.padding = '3px 8px';
    tag.style.borderRadius = '999px';
    tag.style.fontSize = '12px';
    tag.style.fontWeight = '600';
    tag.style.boxShadow = '0 2px 8px rgba(220, 38, 38, 0.4)';
    tag.style.whiteSpace = 'nowrap';
    tag.style.marginBottom = '4px';
    el.appendChild(tag);

    const dot = document.createElement('span');
    dot.style.width = '14px';
    dot.style.height = '14px';
    dot.style.borderRadius = '50%';
    dot.style.background = '#dc2626';
    dot.style.border = '3px solid #ffffff';
    dot.style.boxShadow = '0 0 0 6px rgba(220, 38, 38, 0.25), 0 2px 6px rgba(0, 0, 0, 0.35)';
    el.appendChild(dot);

    const displayCoord = wgs84ToDisplay(searchPreview.lng, searchPreview.lat, basemap);
    previewMarkerRef.current = new maplibregl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat(displayCoord)
      .addTo(map);
  }, [searchPreview, basemap]);

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
        <div className="draw-banner">
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
          <span>
            {draftCoords.length < 2
              ? draftCoords.length === 0
                ? '点击地图或已有标注点选择起点'
                : '继续点击地图或已有标注点选择终点'
              : routeLoading
                ? '正在规划路线...'
                : routeError
                  ? `规划失败：${routeError}`
                  : routeResult
                    ? `${formatDistance(routeResult.distance_meters)} · 约 ${formatDuration(routeResult.duration_seconds)} (${routeResult.provider.toUpperCase()})`
                    : ''}
          </span>
          {draftCoords.length > 0 && (
            <button
              className="btn"
              onClick={() => {
                setDraftCoords((prev) => prev.slice(0, -1));
                setDraftNames((prev) => prev.slice(0, -1));
              }}
            >
              撤销一点
            </button>
          )}
          {canEdit && routeResult && (
            <button
              className="btn primary"
              onClick={() => {
                onSaveRoute(routeResult, draftNames);
                setDraftCoords([]);
                setDraftNames([]);
                setRouteResult(null);
              }}
            >
              保存为路线
            </button>
          )}
          {draftCoords.length > 0 && (
            <button
              className="btn"
              onClick={() => {
                setDraftCoords([]);
                setDraftNames([]);
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
      {renderDraftBanner()}
    </>
  );
}
