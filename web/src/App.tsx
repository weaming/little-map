import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cloneMap,
  createMap,
  deleteAdminMap,
  deleteFeatures,
  extractErrorMessage,
  fetchAdminMaps,
  fetchCapabilities,
  fetchMap,
  getExportUrl,
  planRoute,
  reverseGeocode,
  updateMapMeta,
  upsertFeatures,
  type FeaturePayload,
} from './api/client';
import { BeikeClusterCard } from './components/BeikeClusterCard';
import { FeatureInspector } from './components/FeatureInspector';
import { MapCanvas } from './components/MapCanvas';
import { PlaceDetailCard } from './components/PlaceDetailCard';
import { ShareModal } from './components/ShareModal';
import { Sidebar } from './components/Sidebar';
import { Toolbar } from './components/Toolbar';
import {
  clusterBeikeHouses,
  featuresViewport,
  formatBeikeHousesCSV,
  formatDistance,
  geometryBounds,
  geometryCenter,
  getCurrentPositionWgs84,
  pickDominantColor,
  placesViewport,
  type WgsBounds,
} from './map/geo';
import type {
  AdminMapSummary,
  BasemapId,
  BeikeHouse,
  BeikeSearchResult,
  DrawTool,
  GeoGeometry,
  MapFeature,
  MapMeta,
  OverlayId,
  PlaceResult,
  RouteResult,
  ServerCapabilities,
  TrafficSegment,
} from './types/map';

interface RecentMapItem {
  id: string;
  title: string;
  editToken: string;
}

const RECENT_STORAGE_KEY = 'little_map_recent_v1';
const VIEW_STORAGE_PREFIX = 'little_map_view_v1:';
const OVERLAY_STORAGE_PREFIX = 'little_map_overlay_v1:';
const ADMIN_KEY_STORAGE = 'little_map_admin_key_v1';

function loadSavedOverlay(mapId: string): OverlayId {
  try {
    const val = localStorage.getItem(OVERLAY_STORAGE_PREFIX + mapId);
    if (
      val === 'none' ||
      val === 'amap-label' ||
      val === 'amap-road' ||
      val === 'baidu-road' ||
      val === 'google-road'
    ) {
      return val;
    }
  } catch {
    // 忽略存储读取异常
  }
  return 'none';
}

function saveOverlay(mapId: string, overlay: OverlayId) {
  try {
    localStorage.setItem(OVERLAY_STORAGE_PREFIX + mapId, overlay);
  } catch {
    // 忽略存储写入异常
  }
}

interface SavedView {
  lng: number;
  lat: number;
  zoom: number;
}

function loadSavedView(mapId: string): SavedView | null {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_PREFIX + mapId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedView>;
    if (
      typeof parsed.lng === 'number' &&
      typeof parsed.lat === 'number' &&
      typeof parsed.zoom === 'number' &&
      Number.isFinite(parsed.lng) &&
      Number.isFinite(parsed.lat) &&
      Number.isFinite(parsed.zoom)
    ) {
      return { lng: parsed.lng, lat: parsed.lat, zoom: parsed.zoom };
    }
    return null;
  } catch {
    return null;
  }
}

function saveView(mapId: string, view: SavedView) {
  try {
    localStorage.setItem(VIEW_STORAGE_PREFIX + mapId, JSON.stringify(view));
  } catch {
    // 忽略隐私模式或配额不足错误
  }
}

function readUrlParams(): { mapId: string; editToken: string } {
  const params = new URLSearchParams(window.location.search);
  return {
    mapId: params.get('m')?.trim() ?? '',
    editToken: params.get('t')?.trim() ?? '',
  };
}

function loadRecentMaps(): RecentMapItem[] {
  try {
    const raw = localStorage.getItem(RECENT_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as RecentMapItem[]) : [];
  } catch {
    return [];
  }
}

function saveRecentMap(item: RecentMapItem): RecentMapItem[] {
  const list = loadRecentMaps().filter((x) => x.id !== item.id);
  list.unshift(item);
  const sliced = list.slice(0, 50);
  localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(sliced));
  return sliced;
}

function removeRecentMapStorage(id: string): RecentMapItem[] {
  const next = loadRecentMaps().filter((x) => x.id !== id);
  localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
  try {
    localStorage.removeItem(VIEW_STORAGE_PREFIX + id);
    localStorage.removeItem(OVERLAY_STORAGE_PREFIX + id);
  } catch {
    // 忽略存储清理异常
  }
  return next;
}

function pruneRecentMapsByValidIds(validIds: Set<string>): RecentMapItem[] {
  const cur = loadRecentMaps();
  const next = cur.filter((x) => validIds.has(x.id));
  if (next.length !== cur.length) {
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
  }
  return next;
}

export function App() {
  const initialParams = readUrlParams();
  const [mapId, setMapId] = useState(initialParams.mapId);
  const [editToken, setEditToken] = useState(initialParams.editToken);
  const [capabilities, setCapabilities] = useState<ServerCapabilities>({
    default_basemap: 'amap-vec',
    search_providers: ['osm'],
    has_amap_key: false,
    has_google_key: false,
    has_admin_key: false,
  });

  const [adminKey, setAdminKey] = useState(() => localStorage.getItem(ADMIN_KEY_STORAGE) ?? '');
  const [adminInput, setAdminInput] = useState('');
  const [adminMaps, setAdminMaps] = useState<AdminMapSummary[] | null>(null);
  const [recentMaps, setRecentMaps] = useState<RecentMapItem[]>(() => loadRecentMaps());
  const [adminError, setAdminError] = useState('');
  const [adminLoading, setAdminLoading] = useState(false);

  const [mapMeta, setMapMeta] = useState<MapMeta | null>(null);
  const [features, setFeatures] = useState<MapFeature[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [basemap, setBasemap] = useState<BasemapId>('amap-vec');
  const [overlay, setOverlay] = useState<OverlayId>(() => (initialParams.mapId ? loadSavedOverlay(initialParams.mapId) : 'none'));
  const [showTraffic, setShowTraffic] = useState(false);
  const [tool, setTool] = useState<DrawTool>('select');
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
  const [showShare, setShowShare] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [toast, setToast] = useState<{ text: string; isConflict?: boolean } | null>(null);
  const [flyTarget, setFlyTarget] = useState<{
    lng: number;
    lat: number;
    zoom?: number;
    bounds?: WgsBounds;
    seq: number;
  } | null>(null);
  const [userLocation, setUserLocation] = useState<[number, number] | null>(null);
  const [searchResults, setSearchResults] = useState<PlaceResult[]>([]);
  const [activeSearchIndex, setActiveSearchIndex] = useState<number | null>(null);
  const [beikeHouses, setBeikeHouses] = useState<BeikeHouse[]>([]);
  const [beikeMeta, setBeikeMeta] = useState<Omit<BeikeSearchResult, 'houses'> | null>(null);
  const [activeBeikeClusterKey, setActiveBeikeClusterKey] = useState<string | null>(null);
  const [beikeViewportOnly, setBeikeViewportOnly] = useState(false);
  const [beikeKeyword, setBeikeKeyword] = useState('');
  const [beikeBizcircles, setBeikeBizcircles] = useState<string[]>([]);
  const [beikeCopyWithPhotos, setBeikeCopyWithPhotos] = useState(false);
  const [currentViewportBounds, setCurrentViewportBounds] = useState<WgsBounds | null>(null);
  const [externalWaypoint, setExternalWaypoint] = useState<{
    coord: [number, number];
    name?: string;
    seq: number;
  } | null>(null);
  const [editingLineFeatureId, setEditingLineFeatureId] = useState<string | null>(null);
  const [trafficOverlay, setTrafficOverlay] = useState<{
    featureId: string;
    segments: TrafficSegment[];
  } | null>(null);
  const [trafficLoading, setTrafficLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  const etagRef = useRef<string | undefined>(undefined);
  const autoLocatedMapRef = useRef<string>('');
  const toastTimerRef = useRef<number | undefined>(undefined);
  const currentViewportRef = useRef<{ center: [number, number]; bounds?: WgsBounds } | null>(null);

  const notify = useCallback((text: string, isConflict = false) => {
    setToast({ text, isConflict });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    if (!isConflict) {
      toastTimerRef.current = window.setTimeout(() => setToast(null), 3200);
    }
  }, []);

  useEffect(() => {
    document.title = mapMeta?.title ? `${mapMeta.title} - Little Map` : 'Little Map';
  }, [mapMeta?.title]);

  useEffect(() => {
    fetchCapabilities()
      .then((cap) => {
        setCapabilities(cap);
        setBasemap(cap.default_basemap);
      })
      .catch(() => {});
  }, []);

  const loadAdminList = useCallback(async (key: string) => {
    const trimmed = key.trim();
    if (!trimmed) return;
    setAdminLoading(true);
    setAdminError('');
    try {
      const list = await fetchAdminMaps(trimmed);
      localStorage.setItem(ADMIN_KEY_STORAGE, trimmed);
      setAdminKey(trimmed);
      setAdminMaps(list);
      setRecentMaps(pruneRecentMapsByValidIds(new Set(list.map((m) => m.id))));
    } catch (err) {
      setAdminMaps(null);
      setAdminError(extractErrorMessage(err).message);
    } finally {
      setAdminLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!mapId && capabilities.has_admin_key && adminKey && adminMaps === null) {
      void loadAdminList(adminKey);
    }
  }, [mapId, capabilities.has_admin_key, adminKey, adminMaps, loadAdminList]);

  const syncMap = useCallback(
    async (force = false) => {
      if (!mapId) return;
      setIsSyncing(true);
      try {
        const res = await fetchMap(mapId, editToken, force ? undefined : etagRef.current);
        if (!res.notModified && res.snapshot) {
          etagRef.current = res.etag;
          setMapMeta(res.snapshot.map);
          setFeatures(res.snapshot.features);
          setCanEdit(res.snapshot.can_edit);
          if (force) {
            setBasemap(res.snapshot.map.basemap || 'amap-vec');
            const hasSavedView = loadSavedView(res.snapshot.map.id) !== null;
            if (!hasSavedView && autoLocatedMapRef.current !== res.snapshot.map.id) {
              autoLocatedMapRef.current = res.snapshot.map.id;
              const visibleVp = featuresViewport(res.snapshot.features);
              if (visibleVp) {
                setFlyTarget({
                  lng: visibleVp.center[0],
                  lat: visibleVp.center[1],
                  zoom: visibleVp.bounds ? undefined : 14,
                  bounds: visibleVp.bounds,
                  seq: Date.now(),
                });
              } else {
                const isDefaultCenter =
                  Math.abs(res.snapshot.map.center_lng - 116.3974) < 1e-4 &&
                  Math.abs(res.snapshot.map.center_lat - 39.9093) < 1e-4;
                if (isDefaultCenter) {
                  void getCurrentPositionWgs84(2500).then((pos) => {
                    if (!pos) return;
                    setUserLocation(pos);
                    setFlyTarget({ lng: pos[0], lat: pos[1], zoom: 13, seq: Date.now() });
                  });
                }
              }
            }
          }
          setRecentMaps(
            saveRecentMap({
              id: res.snapshot.map.id,
              title: res.snapshot.map.title,
              editToken: res.snapshot.can_edit ? editToken : '',
            }),
          );
        }
      } catch (err) {
        const { message, isNotFound } = extractErrorMessage(err);
        if (isNotFound) {
          setRecentMaps(removeRecentMapStorage(mapId));
          window.history.replaceState({}, '', '/');
          setMapId('');
          setEditToken('');
          setMapMeta(null);
          setFeatures([]);
          setSelectedFeatureId(null);
          notify('该地图不存在或已被删除，已从最近访问中移除');
          return;
        }
        notify(`加载地图失败：${message}`);
      } finally {
        setIsSyncing(false);
      }
    },
    [mapId, editToken, notify],
  );

  // 首次加载地图 + 10s 低频 ETag 轮询（页面隐藏自动暂停）
  useEffect(() => {
    if (!mapId) return;
    etagRef.current = undefined;
    setOverlay(loadSavedOverlay(mapId));
    void syncMap(true);

    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void syncMap(false);
      }
    }, 10000);
    return () => window.clearInterval(timer);
  }, [mapId, editToken, syncMap]);

  async function handleCreateNewMap(customTitle?: string) {
    setCreating(true);
    try {
      const pos = await getCurrentPositionWgs84(2500);
      if (pos) setUserLocation(pos);

      const resp = await createMap({
        title: customTitle?.trim() || '新建协作地图',
        basemap: capabilities.default_basemap,
        ...(pos ? { center_lng: pos[0], center_lat: pos[1], zoom: 13 } : {}),
      });
      const nextUrl = `/?m=${encodeURIComponent(resp.map.id)}&t=${encodeURIComponent(resp.edit_token)}`;
      window.history.pushState({}, '', nextUrl);
      etagRef.current = undefined;
      setMapId(resp.map.id);
      setEditToken(resp.edit_token);
      setMapMeta(resp.map);
      setFeatures([]);
      setCanEdit(true);
      setBasemap(resp.map.basemap);
      setSelectedFeatureId(null);
      setRecentMaps(saveRecentMap({ id: resp.map.id, title: resp.map.title, editToken: resp.edit_token }));
      notify('已创建新地图，可点击右上角「分享」获取链接');
    } catch (err) {
      notify(`创建失败：${extractErrorMessage(err).message}`);
    } finally {
      setCreating(false);
    }
  }

  async function handleCloneMap() {
    if (!mapMeta) return;
    try {
      const resp = await cloneMap(mapMeta.id);
      const nextUrl = `/?m=${encodeURIComponent(resp.map.id)}&t=${encodeURIComponent(resp.edit_token)}`;
      window.history.pushState({}, '', nextUrl);
      etagRef.current = undefined;
      setMapId(resp.map.id);
      setEditToken(resp.edit_token);
      setSelectedFeatureId(null);
      setSearchResults([]);
      setActiveSearchIndex(null);
      setRecentMaps(saveRecentMap({ id: resp.map.id, title: resp.map.title, editToken: resp.edit_token }));
      notify(`已复制为「${resp.map.title}」，现在可自由编辑`);
    } catch (err) {
      notify(`复制失败：${extractErrorMessage(err).message}`);
    }
  }

  async function handleLocateMe() {
    const pos = await getCurrentPositionWgs84(5000);
    if (!pos) {
      notify('无法获取当前位置，请确认浏览器已授予位置权限（非本机需 HTTPS）');
      return;
    }
    setUserLocation(pos);
    setFlyTarget({ lng: pos[0], lat: pos[1], zoom: 14, seq: Date.now() });
  }

  async function handleRenameMap(title: string) {
    if (!mapMeta || !canEdit) return;
    try {
      const updated = await updateMapMeta(mapMeta.id, editToken, mapMeta.revision, { title });
      setMapMeta(updated);
      etagRef.current = undefined;
      setRecentMaps(saveRecentMap({ id: updated.id, title: updated.title, editToken }));
    } catch (err) {
      const { message, isConflict } = extractErrorMessage(err);
      notify(message, isConflict);
    }
  }

  async function handleBasemapChange(next: BasemapId) {
    setBasemap(next);
    if (mapMeta && canEdit) {
      try {
        const updated = await updateMapMeta(mapMeta.id, editToken, mapMeta.revision, { basemap: next });
        setMapMeta(updated);
        etagRef.current = undefined;
      } catch {
        // 切换底图允许仅本地生效，不打断浏览
      }
    }
  }

  async function handleCreateGeometry(geometry: GeoGeometry) {
    if (!mapMeta || !canEdit) return;
    const labelMap = { Point: '新标注点', LineString: '新折线', Polygon: '新区域' };
    let title = `${labelMap[geometry.type]} ${features.length + 1}`;
    let description = '';

    if (geometry.type === 'Point' && capabilities.has_amap_key) {
      const [lng, lat] = geometry.coordinates as number[];
      try {
        const place = await reverseGeocode(lng, lat);
        if (place?.name) {
          title = place.name;
          if (place.address && place.address !== place.name) {
            description = place.address;
          }
        }
      } catch {
        // 逆地理编码失败时回退默认名称，不阻断打点
      }
    }

    try {
      const resp = await upsertFeatures(mapMeta.id, editToken, mapMeta.revision, [
        {
          title,
          description,
          color: pickDominantColor(features, geometry.type, '#2563eb'),
          geometry,
          visible: true,
        },
      ]);
      setMapMeta((prev) => (prev ? { ...prev, revision: resp.revision } : prev));
      setFeatures((prev) => [...prev, ...resp.features]);
      if (resp.features[0]) {
        setSelectedFeatureId(resp.features[0].id);
      }
      setTool('select');
      etagRef.current = undefined;
    } catch (err) {
      const { message, isConflict } = extractErrorMessage(err);
      notify(message, isConflict);
    }
  }

  async function handleSaveRoute(route: RouteResult, waypointNames: string[]) {
    if (!mapMeta || !canEdit) return;
    const modeLabel =
      route.mode === 'walking' ? '徒步路线' : route.mode === 'driving' ? '驾车路线' : '骑行路线';
    const defaultColor =
      route.mode === 'walking' ? '#16a34a' : route.mode === 'driving' ? '#d97706' : '#2563eb';
    const formatDur = (sec: number) => {
      const m = Math.max(1, Math.round(sec / 60));
      return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分钟` : `${m} 分钟`;
    };
    const strategyName = (s: string) => {
      switch (s) {
        case 'highway':
          return '高速优先';
        case 'national':
          return '国道/不走高速';
        case 'avoid-jam':
          return '躲避拥堵';
        case 'direct':
          return '自由直线';
        default:
          return '智能默认';
      }
    };
    const distText = formatDistance(route.distance_meters);
    const durText = formatDur(route.duration_seconds);
    const namedStops = waypointNames.filter((n) => n.trim() !== '');
    const title =
      namedStops.length >= 2
        ? `${modeLabel}：${namedStops[0]} → ${namedStops[namedStops.length - 1]}`
        : `${modeLabel} · ${distText}`;
    const stopsLine = namedStops.length > 0 ? `\n- 途经点：${namedStops.join(' → ')}` : '';

    let legsSection = '';
    if (route.legs && route.legs.length > 0) {
      const rows = route.legs.map((leg) => {
        const legDist = formatDistance(leg.distance_meters);
        const legDur = formatDur(leg.duration_seconds);
        const link = leg.amap_nav_url ? ` · [打开高德导航](${leg.amap_nav_url})` : '';
        return `${leg.index}. **${strategyName(leg.strategy)}**（${legDist} · 约 ${legDur}）${link}`;
      });
      legsSection = `\n\n### 分段接力导航（共 ${route.legs.length} 段）\n` + rows.join('\n');
    }

    try {
      const resp = await upsertFeatures(mapMeta.id, editToken, mapMeta.revision, [
        {
          title,
          category: modeLabel,
          description: `- 方式：${modeLabel}\n- 总距离：${distText}\n- 预计耗时：约 ${durText}${stopsLine}\n- 规划源：${route.provider.toUpperCase()}${legsSection}`,
          color: pickDominantColor(features, 'LineString', defaultColor),
          geometry: route.geometry,
          visible: true,
        },
      ]);
      setMapMeta((prev) => (prev ? { ...prev, revision: resp.revision } : prev));
      setFeatures((prev) => [...prev, ...resp.features]);
      if (resp.features[0]) {
        setSelectedFeatureId(resp.features[0].id);
      }
      setTool('select');
      etagRef.current = undefined;
      notify(`已保存${modeLabel}（${distText}）`);
    } catch (err) {
      const { message, isConflict } = extractErrorMessage(err);
      notify(message, isConflict);
    }
  }

  async function handleToggleTraffic(feature: MapFeature) {
    if (feature.geometry.type !== 'LineString') return;
    if (trafficOverlay?.featureId === feature.id) {
      setTrafficOverlay(null);
      return;
    }

    const coords = feature.geometry.coordinates as number[][];
    if (coords.length < 2) return;

    // 均匀抽取最多 12 个关键点（保留首尾），后端通过高德 waypoints 单次请求拉取（仅耗 1 QPS）
    const maxPts = 12;
    const sampled: [number, number][] = [];
    if (coords.length <= maxPts) {
      for (const [lng, lat] of coords) sampled.push([lng, lat]);
    } else {
      const step = (coords.length - 1) / (maxPts - 1);
      for (let i = 0; i < maxPts - 1; i++) {
        const [lng, lat] = coords[Math.round(i * step)];
        sampled.push([lng, lat]);
      }
      const [lastLng, lastLat] = coords[coords.length - 1];
      sampled.push([lastLng, lastLat]);
    }

    setTrafficLoading(true);
    try {
      const res = await planRoute('driving', sampled, 'amap');
      if (!res.traffic_segments || res.traffic_segments.length === 0) {
        notify(
          res.provider.startsWith('amap')
            ? '当前路线暂无实时路况数据'
            : '高德路况拉取失败（已降级 OSRM），请查看服务端日志',
        );
        return;
      }
      setTrafficOverlay({ featureId: feature.id, segments: res.traffic_segments });
      const mins = Math.max(1, Math.round(res.duration_seconds / 60));
      const durText = mins >= 60 ? `${Math.floor(mins / 60)} 小时 ${mins % 60} 分钟` : `${mins} 分钟`;
      notify(`实时路况已更新 · 预计驾车约 ${durText}`);
    } catch (err) {
      notify(`拉取实时路况失败：${extractErrorMessage(err).message}`);
    } finally {
      setTrafficLoading(false);
    }
  }

  async function handleSaveFeature(updated: MapFeature) {
    if (!mapMeta || !canEdit) return;
    try {
      const resp = await upsertFeatures(mapMeta.id, editToken, mapMeta.revision, [
        {
          id: updated.id,
          title: updated.title,
          description: updated.description,
          category: updated.category,
          color: updated.color,
          icon: updated.icon,
          geometry: updated.geometry,
          visible: updated.visible,
          sort_order: updated.sort_order,
        },
      ]);
      setMapMeta((prev) => (prev ? { ...prev, revision: resp.revision } : prev));
      const saved = resp.features[0];
      if (saved) {
        setFeatures((prev) => prev.map((f) => (f.id === saved.id ? saved : f)));
      }
      etagRef.current = undefined;
      notify('已保存');
    } catch (err) {
      const { message, isConflict } = extractErrorMessage(err);
      notify(message, isConflict);
    }
  }

  const handleDeleteFeature = useCallback(
    async (featureId: string) => {
      if (!mapMeta || !canEdit) return;
      try {
        const resp = await deleteFeatures(mapMeta.id, editToken, mapMeta.revision, [featureId]);
        setMapMeta((prev) => (prev ? { ...prev, revision: resp.revision } : prev));
        setFeatures((prev) => prev.filter((f) => f.id !== featureId));
        setSelectedFeatureId(null);
        etagRef.current = undefined;
        notify('已删除标注');
      } catch (err) {
        const { message, isConflict } = extractErrorMessage(err);
        notify(message, isConflict);
      }
    },
    [mapMeta, canEdit, editToken, notify],
  );

  // 选中标注时支持 Delete / Backspace 快捷删除（输入焦点在表单内时忽略）
  useEffect(() => {
    if (!canEdit || !selectedFeatureId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      void handleDeleteFeature(selectedFeatureId);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canEdit, selectedFeatureId, handleDeleteFeature]);

  async function handleAddPlaceMarker(place: PlaceResult, asPolygon = false) {
    if (!mapMeta || !canEdit) return;
    const useBoundary = asPolygon && Boolean(place.boundary);
    const geometry: GeoGeometry = useBoundary
      ? place.boundary!
      : { type: 'Point', coordinates: [place.lng, place.lat] };
    const descLines: string[] = [];
    if (place.address) descLines.push(`- 地址：${place.address}`);
    if (place.open_time) descLines.push(`- 营业时间：${place.open_time}`);
    if (place.tel) descLines.push(`- 电话：${place.tel}`);
    if (place.rating || place.cost) {
      const parts = [place.rating ? `评分 ${place.rating}` : '', place.cost ? `人均 ¥${place.cost}` : ''].filter(Boolean);
      descLines.push(`- 信息：${parts.join(' · ')}`);
    }
    const description = descLines.length > 0 ? descLines.join('\n') : place.address;

    try {
      const resp = await upsertFeatures(mapMeta.id, editToken, mapMeta.revision, [
        {
          title: place.name,
          description,
          category: place.category ?? '',
          color: pickDominantColor(features, geometry.type, useBoundary ? '#2563eb' : '#dc2626'),
          geometry,
          visible: true,
        },
      ]);
      setMapMeta((prev) => (prev ? { ...prev, revision: resp.revision } : prev));
      setFeatures((prev) => [...prev, ...resp.features]);
      if (resp.features[0]) {
        setSelectedFeatureId(resp.features[0].id);
        const bounds = geometryBounds(resp.features[0].geometry) ?? undefined;
        const [lng, lat] = geometryCenter(resp.features[0].geometry);
        setFlyTarget({ lng, lat, bounds, seq: Date.now() });
      }
      etagRef.current = undefined;
      notify(useBoundary ? `已按范围标注「${place.name}」` : `已添加「${place.name}」`);
    } catch (err) {
      const { message, isConflict } = extractErrorMessage(err);
      notify(message, isConflict);
    }
  }

  const beikeClusters = useMemo(
    () =>
      clusterBeikeHouses(
        beikeHouses,
        beikeViewportOnly ? currentViewportBounds : null,
        beikeKeyword,
        beikeBizcircles,
      ),
    [beikeHouses, beikeViewportOnly, currentViewportBounds, beikeKeyword, beikeBizcircles],
  );

  async function handleCopyBeikeCSV(houses: BeikeHouse[]) {
    if (houses.length === 0) {
      notify('当前没有可复制的房源');
      return;
    }
    const csv = formatBeikeHousesCSV(houses, beikeCopyWithPhotos);
    try {
      await navigator.clipboard.writeText(csv);
      notify(`已复制 ${houses.length} 套房源 CSV${beikeCopyWithPhotos ? '（含图片URL）' : '（不含图片）'}`);
    } catch {
      notify('复制失败，请检查浏览器剪贴板权限');
    }
  }

  async function handleSaveBeikeHouse(house: BeikeHouse) {
    if (!mapMeta || !canEdit) return;
    const rentLabel = house.rent_type === 'whole' ? '整租' : house.rent_type === 'shared' ? '合租' : '';
    const descLines: string[] = [
      `- 租金：¥${house.price_text}${house.price_unit || '元/月'}`,
      `- 小区：${[house.district, house.bizcircle, house.resblock].filter(Boolean).join(' · ')}`,
    ];
    const spec = [rentLabel, house.layout, house.area > 0 ? `${house.area}㎡` : '', house.orientation]
      .filter(Boolean)
      .join(' · ');
    if (spec) descLines.push(`- 户型：${spec}`);
    if (house.subway_desc || house.subway_name) {
      descLines.push(`- 地铁：${house.subway_desc || house.subway_name}`);
    }
    if (house.tags.length > 0) {
      descLines.push(`- 标签：${house.tags.join(' / ')}`);
    }
    descLines.push(`- 房源编号：${house.house_code}`);
    if (house.pic_url) {
      descLines.push('', `![${house.title}](${house.pic_url})`);
    }

    try {
      const resp = await upsertFeatures(mapMeta.id, editToken, mapMeta.revision, [
        {
          title: `${house.resblock || house.title} ¥${house.price_text}`,
          description: descLines.join('\n'),
          category: '租房候选',
          color: '#059669',
          geometry: { type: 'Point', coordinates: [house.lng, house.lat] },
          visible: true,
        },
      ]);
      setMapMeta((prev) => (prev ? { ...prev, revision: resp.revision } : prev));
      setFeatures((prev) => [...prev, ...resp.features]);
      etagRef.current = undefined;
      notify(`已收藏「${house.resblock || house.title}」到当前地图`);
    } catch (err) {
      const { message, isConflict } = extractErrorMessage(err);
      notify(message, isConflict);
    }
  }

  async function handleImportGeoJSON(file: File) {
    if (!mapMeta || !canEdit) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as {
        type?: string;
        features?: Array<{ geometry?: GeoGeometry; properties?: Record<string, unknown> }>;
      };
      if (parsed.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) {
        notify('仅支持导入标准 GeoJSON FeatureCollection 文件');
        return;
      }

      const payloads: FeaturePayload[] = [];
      for (const item of parsed.features) {
        if (!item.geometry || !['Point', 'LineString', 'Polygon'].includes(item.geometry.type)) continue;
        const props = item.properties ?? {};
        payloads.push({
          title: String(props.title || props.name || '导入标注'),
          description: String(props.description || ''),
          category: String(props.category || ''),
          color: typeof props.color === 'string' && props.color ? props.color : '#2563eb',
          geometry: item.geometry,
          visible: true,
        });
      }

      if (payloads.length === 0) {
        notify('文件中没有可导入的 Point / LineString / Polygon 要素');
        return;
      }

      const resp = await upsertFeatures(mapMeta.id, editToken, mapMeta.revision, payloads);
      setMapMeta((prev) => (prev ? { ...prev, revision: resp.revision } : prev));
      setFeatures((prev) => [...prev, ...resp.features]);
      etagRef.current = undefined;
      notify(`成功导入 ${resp.features.length} 条标注`);
    } catch (err) {
      const { message, isConflict } = extractErrorMessage(err);
      notify(`导入失败：${message}`, isConflict);
    }
  }

  function handleSelectFromSidebar(id: string) {
    const target = features.find((f) => f.id === id);
    if (!target) return;
    const [lng, lat] = geometryCenter(target.geometry);
    if (tool === 'route') {
      setExternalWaypoint({ coord: [lng, lat], name: target.title, seq: Date.now() });
      notify(`已添加途经点「${target.title || '未命名标注'}」`);
      return;
    }
    setSelectedFeatureId(id);
    const bounds = geometryBounds(target.geometry) ?? undefined;
    setFlyTarget({ lng, lat, bounds, seq: Date.now() });
  }

  // 无 mapId 时展示欢迎页
  if (!mapId) {
    return (
      <div className="welcome-screen">
        <div className="welcome-card">
          <h2 style={{ margin: '0 0 8px' }}>Little Map</h2>
          <p style={{ margin: '0 0 18px', fontSize: 13, color: '#64748b', lineHeight: 1.6 }}>
            免登录多人协作地图标注工具 · 支持高德 / Google / OSM 双底图自动纠偏、测距、搜索与 AI MCP 接入。
          </p>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleCreateNewMap(newTitle);
            }}
            style={{ display: 'flex', gap: 8 }}
          >
            <input
              className="text-input"
              placeholder="输入地图名称，例如：川西自驾计划"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
            />
            <button type="submit" className="btn primary" disabled={creating}>
              {creating ? '创建中...' : '创建地图'}
            </button>
          </form>

          {recentMaps.length > 0 && (
            <div style={{ marginTop: 22 }}>
              <div className="field-label">最近访问（本浏览器）</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 200, overflowY: 'auto' }}>
                {recentMaps.map((item) => (
                  <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button
                      className="btn outline"
                      style={{ flex: 1, minWidth: 0, justifyContent: 'space-between' }}
                      onClick={() => {
                        const url = item.editToken
                          ? `/?m=${encodeURIComponent(item.id)}&t=${encodeURIComponent(item.editToken)}`
                          : `/?m=${encodeURIComponent(item.id)}`;
                        window.location.href = url;
                      }}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.title}
                      </span>
                      <span className="badge">{item.editToken ? '可编辑' : '只读'}</span>
                    </button>
                    <button
                      className="btn"
                      style={{ padding: '4px 7px', color: '#94a3b8' }}
                      title="从最近访问移除"
                      onClick={() => setRecentMaps(removeRecentMapStorage(item.id))}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {capabilities.has_admin_key && (
            <div style={{ marginTop: 22, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div className="field-label" style={{ marginBottom: 0 }}>
                  全部地图管理（管理员）
                </div>
                {adminMaps !== null && (
                  <button
                    className="btn"
                    style={{ padding: '2px 6px', fontSize: 12 }}
                    onClick={() => {
                      localStorage.removeItem(ADMIN_KEY_STORAGE);
                      setAdminKey('');
                      setAdminInput('');
                      setAdminMaps(null);
                    }}
                  >
                    退出管理
                  </button>
                )}
              </div>

              {adminMaps === null ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void loadAdminList(adminInput);
                  }}
                  style={{ display: 'flex', gap: 8 }}
                >
                  <input
                    type="password"
                    className="text-input"
                    placeholder="输入管理员口令查看全部地图"
                    value={adminInput}
                    onChange={(e) => setAdminInput(e.target.value)}
                  />
                  <button type="submit" className="btn outline" disabled={adminLoading}>
                    {adminLoading ? '验证中...' : '解锁'}
                  </button>
                </form>
              ) : adminMaps.length === 0 ? (
                <div style={{ fontSize: 12, color: '#64748b' }}>服务端暂无地图</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
                  {adminMaps.map((m) => (
                    <div
                      key={m.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        padding: '6px 8px',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                      }}
                    >
                      <div
                        style={{ minWidth: 0, flex: 1, cursor: 'pointer' }}
                        onClick={() => {
                          window.location.href = `/?m=${encodeURIComponent(m.id)}&t=${encodeURIComponent(m.edit_token)}`;
                        }}
                      >
                        <div className="feature-title">{m.title}</div>
                        <div className="feature-sub">
                          {m.feature_count} 条标注 · {m.updated_at.slice(0, 16).replace('T', ' ')}
                        </div>
                      </div>
                      <button
                        className="btn danger"
                        style={{ padding: '3px 7px', fontSize: 12 }}
                        onClick={async () => {
                          if (!window.confirm(`确定永久删除地图「${m.title}」？`)) return;
                          try {
                            await deleteAdminMap(adminKey, m.id);
                            setAdminMaps((prev) => (prev ? prev.filter((x) => x.id !== m.id) : prev));
                            setRecentMaps(removeRecentMapStorage(m.id));
                          } catch (err) {
                            setAdminError(extractErrorMessage(err).message);
                          }
                        }}
                      >
                        删除
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {adminError && <div style={{ fontSize: 12, color: '#dc2626', marginTop: 6 }}>{adminError}</div>}
            </div>
          )}
        </div>
      </div>
    );
  }

  const selectedFeature = features.find((f) => f.id === selectedFeatureId) ?? null;
  const activeBeikeCluster = beikeClusters.find((c) => c.key === activeBeikeClusterKey) ?? null;
  const savedView = mapMeta ? loadSavedView(mapMeta.id) : null;

  return (
    <div className="app-shell">
      {mapMeta && (
        <>
          <MapCanvas
            key={mapMeta.id}
            basemap={basemap}
            overlay={overlay}
            showTraffic={showTraffic}
            canEdit={canEdit}
            initialCenter={savedView ? [savedView.lng, savedView.lat] : [mapMeta.center_lng, mapMeta.center_lat]}
            initialZoom={savedView ? savedView.zoom : mapMeta.zoom}
            features={features}
            selectedFeatureId={selectedFeatureId}
            editingLineFeatureId={editingLineFeatureId}
            searchResults={searchResults}
            activeSearchIndex={activeSearchIndex}
            beikeClusters={beikeClusters}
            activeBeikeClusterKey={activeBeikeClusterKey}
            trafficOverlay={trafficOverlay?.segments ?? null}
            tool={tool}
            flyTarget={flyTarget}
            userLocation={userLocation}
            externalWaypoint={externalWaypoint}
            onSelectFeature={(id) => {
              setSelectedFeatureId(id);
              if (id !== editingLineFeatureId) setEditingLineFeatureId(null);
              if (id !== trafficOverlay?.featureId) setTrafficOverlay(null);
              setActiveSearchIndex(null);
              setActiveBeikeClusterKey(null);
            }}
            onSelectSearchResult={(idx) => {
              const place = searchResults[idx];
              if (!place) return;
              setSelectedFeatureId(null);
              setActiveBeikeClusterKey(null);
              setActiveSearchIndex(idx);
            }}
            onSelectBeikeCluster={(key) => {
              const target = beikeClusters.find((c) => c.key === key);
              if (!target) return;
              setSelectedFeatureId(null);
              setActiveSearchIndex(null);
              setActiveBeikeClusterKey(key);
            }}
            onCreateGeometry={handleCreateGeometry}
            onSaveRoute={(route, names) => void handleSaveRoute(route, names)}
            onSaveEditedLine={(featureId, coords) => {
              const target = features.find((f) => f.id === featureId);
              if (target) {
                void handleSaveFeature({
                  ...target,
                  geometry: { type: 'LineString', coordinates: coords },
                });
              }
              setEditingLineFeatureId(null);
            }}
            onCancelEditLine={() => setEditingLineFeatureId(null)}
            onToolCancel={() => setTool('select')}
            onViewChange={(view) => saveView(mapMeta.id, view)}
            onViewportChange={(vp) => {
              currentViewportRef.current = vp;
              setCurrentViewportBounds(vp.bounds);
            }}
          />

          <Toolbar
            tool={tool}
            basemap={basemap}
            overlay={overlay}
            showTraffic={showTraffic}
            canEdit={canEdit}
            onToolChange={setTool}
            onBasemapChange={handleBasemapChange}
            onOverlayChange={(next) => {
              setOverlay(next);
              saveOverlay(mapMeta.id, next);
            }}
            onToggleTraffic={() => setShowTraffic((v) => !v)}
            onShare={() => setShowShare(true)}
            onCloneMap={() => void handleCloneMap()}
            onCreateNew={() => void handleCreateNewMap()}
            onExport={() => {
              window.location.href = getExportUrl(mapMeta.id);
            }}
            onImportGeoJSON={handleImportGeoJSON}
            onLocateMe={() => void handleLocateMe()}
            onGoHome={() => {
              window.history.pushState({}, '', '/');
              setMapId('');
              setEditToken('');
              setMapMeta(null);
              setFeatures([]);
              setSelectedFeatureId(null);
              setSearchResults([]);
              setActiveSearchIndex(null);
            }}
          />

          <Sidebar
            key={mapMeta.id}
            mapMeta={mapMeta}
            features={features}
            selectedFeatureId={selectedFeatureId}
            canEdit={canEdit}
            isSyncing={isSyncing}
            hasBeike={Boolean(capabilities.has_beike)}
            hasAmapKey={capabilities.has_amap_key}
            searchProviders={capabilities.search_providers}
            searchResults={searchResults}
            activeSearchIndex={activeSearchIndex}
            beikeHouses={beikeHouses}
            beikeClusters={beikeClusters}
            beikeMeta={beikeMeta}
            activeBeikeClusterKey={activeBeikeClusterKey}
            beikeViewportOnly={beikeViewportOnly}
            beikeKeyword={beikeKeyword}
            beikeBizcircles={beikeBizcircles}
            beikeCopyWithPhotos={beikeCopyWithPhotos}
            onBeikeViewportOnlyChange={setBeikeViewportOnly}
            onBeikeKeywordChange={setBeikeKeyword}
            onBeikeBizcirclesChange={setBeikeBizcircles}
            onBeikeCopyWithPhotosChange={setBeikeCopyWithPhotos}
            onBeikeCopyCSV={(houses) => void handleCopyBeikeCSV(houses)}
            onBeikeResultsReplace={(res) => {
              const { houses, ...rest } = res;
              setBeikeHouses(houses);
              setBeikeMeta(rest);
              setActiveBeikeClusterKey(null);
              setBeikeBizcircles([]);
              const vp = placesViewport(houses);
              if (vp) {
                setFlyTarget({
                  lng: vp.center[0],
                  lat: vp.center[1],
                  zoom: vp.bounds ? undefined : 14,
                  bounds: vp.bounds,
                  seq: Date.now(),
                });
              }
            }}
            onBeikeResultsAppend={(res) => {
              const { houses, ...rest } = res;
              setBeikeMeta(rest);
              const seen = new Set(beikeHouses.map((h) => h.house_code));
              const merged = [...beikeHouses];
              let added = 0;
              for (const h of houses) {
                if (!seen.has(h.house_code)) {
                  seen.add(h.house_code);
                  merged.push(h);
                  added++;
                }
              }
              setBeikeHouses(merged);
              if (added > 0) {
                notify(`已加载更多：新增 ${added} 套房源（共 ${merged.length} 套）`);
              } else if (res.scanned > 0) {
                notify(`已扫描 ${res.scanned} 套，当前条件下无新增房源`);
              } else {
                notify(res.notes?.[0] || '本页未返回新房源，可能已到末尾或触发限流');
              }
            }}
            onBeikeClear={() => {
              setBeikeHouses([]);
              setBeikeMeta(null);
              setActiveBeikeClusterKey(null);
              setBeikeKeyword('');
              setBeikeBizcircles([]);
            }}
            onSelectBeikeCluster={(key) => {
              const target = beikeClusters.find((c) => c.key === key);
              if (!target) return;
              setSelectedFeatureId(null);
              setActiveSearchIndex(null);
              setActiveBeikeClusterKey(key);
              setFlyTarget({ lng: target.lng, lat: target.lat, seq: Date.now() });
            }}
            getSearchOptions={() => ({
              center:
                currentViewportRef.current?.center ??
                userLocation ??
                [mapMeta.center_lng, mapMeta.center_lat],
              bounds: currentViewportRef.current?.bounds,
            })}
            onRenameMap={handleRenameMap}
            onRefresh={() => void syncMap(true)}
            onSelectFeature={handleSelectFromSidebar}
            onToggleVisible={(f) => void handleSaveFeature({ ...f, visible: !f.visible })}
            onSearchResults={(results) => {
              setSearchResults(results);
              setActiveSearchIndex(results.length === 1 ? 0 : null);
              const vp = placesViewport(results);
              if (vp) {
                setFlyTarget({
                  lng: vp.center[0],
                  lat: vp.center[1],
                  zoom: vp.bounds ? undefined : 15,
                  bounds: vp.bounds,
                  seq: Date.now(),
                });
              }
            }}
            onClearSearch={() => {
              setSearchResults([]);
              setActiveSearchIndex(null);
            }}
            onSelectSearchResult={(idx) => {
              const place = searchResults[idx];
              if (!place) return;
              setSelectedFeatureId(null);
              setActiveSearchIndex(idx);
              const bounds = place.boundary ? (geometryBounds(place.boundary) ?? undefined) : undefined;
              setFlyTarget({ lng: place.lng, lat: place.lat, bounds, seq: Date.now() });
            }}
            onAddPlaceMarker={handleAddPlaceMarker}
          />

          {selectedFeature ? (
            <FeatureInspector
              feature={selectedFeature}
              canEdit={canEdit}
              hasAmapKey={capabilities.has_amap_key}
              isEditingNodes={editingLineFeatureId === selectedFeature.id}
              trafficActive={trafficOverlay?.featureId === selectedFeature.id}
              trafficLoading={trafficLoading}
              onSave={handleSaveFeature}
              onDelete={(fid) => {
                if (editingLineFeatureId === fid) setEditingLineFeatureId(null);
                if (trafficOverlay?.featureId === fid) setTrafficOverlay(null);
                void handleDeleteFeature(fid);
              }}
              onToggleEditNodes={(fid) => {
                setTool('select');
                setTrafficOverlay(null);
                setEditingLineFeatureId((prev) => (prev === fid ? null : fid));
              }}
              onToggleTraffic={(f) => void handleToggleTraffic(f)}
              onClose={() => {
                setEditingLineFeatureId(null);
                setTrafficOverlay(null);
                setSelectedFeatureId(null);
              }}
            />
          ) : activeBeikeCluster ? (
            <BeikeClusterCard
              cluster={activeBeikeCluster}
              canEdit={canEdit}
              copyWithPhotos={beikeCopyWithPhotos}
              onCopyWithPhotosChange={setBeikeCopyWithPhotos}
              onCopyCSV={(houses) => void handleCopyBeikeCSV(houses)}
              onSaveHouse={(h) => void handleSaveBeikeHouse(h)}
              onClose={() => setActiveBeikeClusterKey(null)}
            />
          ) : (
            activeSearchIndex !== null &&
            searchResults[activeSearchIndex] && (
              <PlaceDetailCard
                place={searchResults[activeSearchIndex]}
                index={activeSearchIndex}
                canEdit={canEdit}
                userLocation={userLocation}
                onAddMarker={handleAddPlaceMarker}
                onClose={() => setActiveSearchIndex(null)}
              />
            )
          )}

          {showShare && (
            <ShareModal mapId={mapMeta.id} editToken={canEdit ? editToken : ''} onClose={() => setShowShare(false)} />
          )}
        </>
      )}

      {toast && (
        <div className="toast">
          <span>{toast.text}</span>
          {toast.isConflict && (
            <button
              className="btn primary"
              style={{ padding: '4px 8px' }}
              onClick={() => {
                setToast(null);
                void syncMap(true);
              }}
            >
              立即刷新
            </button>
          )}
        </div>
      )}
    </div>
  );
}
