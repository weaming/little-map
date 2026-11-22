import { useCallback, useEffect, useRef, useState } from 'react';
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
  reverseGeocode,
  updateMapMeta,
  upsertFeatures,
  type FeaturePayload,
} from './api/client';
import { FeatureInspector } from './components/FeatureInspector';
import { MapCanvas } from './components/MapCanvas';
import { ShareModal } from './components/ShareModal';
import { Sidebar } from './components/Sidebar';
import { Toolbar } from './components/Toolbar';
import {
  featuresViewport,
  formatDistance,
  geometryBounds,
  geometryCenter,
  getCurrentPositionWgs84,
  pickDominantColor,
  type WgsBounds,
} from './map/geo';
import type {
  AdminMapSummary,
  BasemapId,
  DrawTool,
  GeoGeometry,
  MapFeature,
  MapMeta,
  OverlayId,
  PlaceResult,
  RouteResult,
  ServerCapabilities,
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
    if (val === 'none' || val === 'amap-label' || val === 'amap-road' || val === 'google-road') return val;
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

function saveRecentMap(item: RecentMapItem) {
  const list = loadRecentMaps().filter((x) => x.id !== item.id);
  list.unshift(item);
  localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(list.slice(0, 50)));
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
  const [adminError, setAdminError] = useState('');
  const [adminLoading, setAdminLoading] = useState(false);

  const [mapMeta, setMapMeta] = useState<MapMeta | null>(null);
  const [features, setFeatures] = useState<MapFeature[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [basemap, setBasemap] = useState<BasemapId>('amap-vec');
  const [overlay, setOverlay] = useState<OverlayId>(() => (initialParams.mapId ? loadSavedOverlay(initialParams.mapId) : 'none'));
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
  const [searchPreview, setSearchPreview] = useState<PlaceResult | null>(null);
  const [externalWaypoint, setExternalWaypoint] = useState<{
    coord: [number, number];
    name?: string;
    seq: number;
  } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  const etagRef = useRef<string | undefined>(undefined);
  const autoLocatedMapRef = useRef<string>('');
  const toastTimerRef = useRef<number | undefined>(undefined);

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
          saveRecentMap({
            id: res.snapshot.map.id,
            title: res.snapshot.map.title,
            editToken: res.snapshot.can_edit ? editToken : '',
          });
        }
      } catch (err) {
        const { message } = extractErrorMessage(err);
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
      saveRecentMap({ id: resp.map.id, title: resp.map.title, editToken: resp.edit_token });
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
      setSearchPreview(null);
      saveRecentMap({ id: resp.map.id, title: resp.map.title, editToken: resp.edit_token });
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
      saveRecentMap({ id: updated.id, title: updated.title, editToken });
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
    const modeLabel = route.mode === 'walking' ? '徒步路线' : '骑行路线';
    const mins = Math.max(1, Math.round(route.duration_seconds / 60));
    const durText = mins >= 60 ? `${Math.floor(mins / 60)} 小时 ${mins % 60} 分钟` : `${mins} 分钟`;
    const distText = formatDistance(route.distance_meters);
    const namedStops = waypointNames.filter((n) => n.trim() !== '');
    const title =
      namedStops.length >= 2
        ? `${modeLabel}：${namedStops[0]} → ${namedStops[namedStops.length - 1]}`
        : `${modeLabel} · ${distText}`;
    const stopsLine = namedStops.length > 0 ? `\n- 途经点：${namedStops.join(' → ')}` : '';
    try {
      const resp = await upsertFeatures(mapMeta.id, editToken, mapMeta.revision, [
        {
          title,
          category: modeLabel,
          description: `- 方式：${modeLabel}\n- 总距离：${distText}\n- 预计耗时：约 ${durText}${stopsLine}\n- 规划源：${route.provider.toUpperCase()}`,
          color: pickDominantColor(features, 'LineString', route.mode === 'walking' ? '#16a34a' : '#2563eb'),
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
    try {
      const resp = await upsertFeatures(mapMeta.id, editToken, mapMeta.revision, [
        {
          title: place.name,
          description: place.address,
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
        setSearchPreview(null);
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
    const recents = loadRecentMaps();
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

          {recents.length > 0 && (
            <div style={{ marginTop: 22 }}>
              <div className="field-label">最近访问（本浏览器）</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 200, overflowY: 'auto' }}>
                {recents.map((item) => (
                  <button
                    key={item.id}
                    className="btn outline"
                    style={{ justifyContent: 'space-between' }}
                    onClick={() => {
                      const url = item.editToken
                        ? `/?m=${encodeURIComponent(item.id)}&t=${encodeURIComponent(item.editToken)}`
                        : `/?m=${encodeURIComponent(item.id)}`;
                      window.location.href = url;
                    }}
                  >
                    <span>{item.title}</span>
                    <span className="badge">{item.editToken ? '可编辑' : '只读'}</span>
                  </button>
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
  const savedView = mapMeta ? loadSavedView(mapMeta.id) : null;

  return (
    <div className="app-shell">
      {mapMeta && (
        <>
          <MapCanvas
            key={mapMeta.id}
            basemap={basemap}
            overlay={overlay}
            canEdit={canEdit}
            initialCenter={savedView ? [savedView.lng, savedView.lat] : [mapMeta.center_lng, mapMeta.center_lat]}
            initialZoom={savedView ? savedView.zoom : mapMeta.zoom}
            features={features}
            selectedFeatureId={selectedFeatureId}
            searchPreview={searchPreview}
            tool={tool}
            flyTarget={flyTarget}
            userLocation={userLocation}
            externalWaypoint={externalWaypoint}
            onSelectFeature={(id) => {
              setSelectedFeatureId(id);
              if (id === null) setSearchPreview(null);
            }}
            onCreateGeometry={handleCreateGeometry}
            onSaveRoute={(route, names) => void handleSaveRoute(route, names)}
            onToolCancel={() => setTool('select')}
            onViewChange={(view) => saveView(mapMeta.id, view)}
          />

          <Toolbar
            tool={tool}
            basemap={basemap}
            overlay={overlay}
            canEdit={canEdit}
            onToolChange={setTool}
            onBasemapChange={handleBasemapChange}
            onOverlayChange={(next) => {
              setOverlay(next);
              saveOverlay(mapMeta.id, next);
            }}
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
            }}
          />

          <Sidebar
            mapMeta={mapMeta}
            features={features}
            selectedFeatureId={selectedFeatureId}
            canEdit={canEdit}
            isSyncing={isSyncing}
            searchProviders={capabilities.search_providers}
            onRenameMap={handleRenameMap}
            onRefresh={() => void syncMap(true)}
            onSelectFeature={handleSelectFromSidebar}
            onToggleVisible={(f) => void handleSaveFeature({ ...f, visible: !f.visible })}
            onPreviewPlace={(place, bounds) => {
              setSearchPreview(place);
              setFlyTarget({ lng: place.lng, lat: place.lat, zoom: 15, bounds, seq: Date.now() });
            }}
            onAddPlaceMarker={handleAddPlaceMarker}
          />

          {selectedFeature && (
            <FeatureInspector
              feature={selectedFeature}
              canEdit={canEdit}
              onSave={handleSaveFeature}
              onDelete={handleDeleteFeature}
              onClose={() => setSelectedFeatureId(null)}
            />
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
