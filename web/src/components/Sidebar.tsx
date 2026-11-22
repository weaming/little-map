import { useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  MapPin,
  Pentagon,
  Plus,
  RefreshCw,
  Search,
  Spline,
} from 'lucide-react';
import { searchPlaces } from '../api/client';
import { formatArea, formatDistance, geometryBounds, lineLengthMeters, polygonAreaSqMeters } from '../map/geo';
import type { MapFeature, MapMeta, PlaceResult } from '../types/map';

interface SidebarProps {
  mapMeta: MapMeta;
  features: MapFeature[];
  selectedFeatureId: string | null;
  canEdit: boolean;
  isSyncing: boolean;
  searchProviders: string[];
  onRenameMap: (title: string) => void;
  onRefresh: () => void;
  onSelectFeature: (id: string) => void;
  onToggleVisible: (feature: MapFeature) => void;
  onPreviewPlace: (place: PlaceResult, bounds?: [[number, number], [number, number]]) => void;
  onAddPlaceMarker: (place: PlaceResult, asPolygon?: boolean) => void;
}

export function Sidebar({
  mapMeta,
  features,
  selectedFeatureId,
  canEdit,
  isSyncing,
  searchProviders,
  onRenameMap,
  onRefresh,
  onSelectFeature,
  onToggleVisible,
  onPreviewPlace,
  onAddPlaceMarker,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth <= 768 : false,
  );
  const [titleDraft, setTitleDraft] = useState(mapMeta.title);
  const [filterText, setFilterText] = useState('');

  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('auto');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<PlaceResult[]>([]);
  const [searchError, setSearchError] = useState('');

  // 当远端刷新标题时同步输入框
  if (titleDraft !== mapMeta.title && document.activeElement?.getAttribute('data-role') !== 'map-title') {
    setTitleDraft(mapMeta.title);
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setSearchError('');
    try {
      const resp = await searchPlaces(query.trim(), provider, 8);
      setSearchResults(resp.results);
      if (resp.results.length === 0) {
        setSearchError('未找到匹配地点');
      }
    } catch {
      setSearchError('搜索服务暂时不可用');
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }

  function featureSummary(f: MapFeature): string {
    if (f.geometry.type === 'Point') {
      const [lng, lat] = f.geometry.coordinates as number[];
      return `${lng.toFixed(4)}, ${lat.toFixed(4)}`;
    }
    if (f.geometry.type === 'LineString') {
      return `折线 · ${formatDistance(lineLengthMeters(f.geometry.coordinates as number[][]))}`;
    }
    const ring = (f.geometry.coordinates as number[][][])[0] ?? [];
    return `区域 · ${formatArea(polygonAreaSqMeters(ring))}`;
  }

  function featureIcon(type: MapFeature['geometry']['type']) {
    if (type === 'Point') return <MapPin size={14} />;
    if (type === 'LineString') return <Spline size={14} />;
    return <Pentagon size={14} />;
  }

  const visibleList = features.filter((f) => {
    const kw = filterText.trim().toLowerCase();
    if (!kw) return true;
    return (
      f.title.toLowerCase().includes(kw) ||
      f.category.toLowerCase().includes(kw) ||
      f.description.toLowerCase().includes(kw)
    );
  });

  if (collapsed) {
    return (
      <div className="sidebar collapsed" onClick={() => setCollapsed(false)} style={{ cursor: 'pointer' }}>
        <div className="sidebar-header" style={{ borderBottom: 'none', padding: '8px 12px' }}>
          <strong style={{ fontSize: 13, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {mapMeta.title}
          </strong>
          <span className="badge">{features.length}</span>
          <button
            className="btn"
            style={{ padding: 4 }}
            onClick={(e) => {
              e.stopPropagation();
              setCollapsed(false);
            }}
            title="展开标注列表"
          >
            <ChevronRight size={15} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <input
          data-role="map-title"
          className="map-title-input"
          value={titleDraft}
          readOnly={!canEdit}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={() => {
            const trimmed = titleDraft.trim();
            if (canEdit && trimmed && trimmed !== mapMeta.title) {
              onRenameMap(trimmed);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <span className={`badge ${canEdit ? 'editable' : ''}`}>{canEdit ? '可编辑' : '只读'}</span>
        <button className="btn" onClick={onRefresh} disabled={isSyncing} title={`刷新同步 (Rev #${mapMeta.revision})`}>
          <RefreshCw size={14} />
        </button>
        <button className="btn" onClick={() => setCollapsed(true)} title="收起侧边栏">
          <ChevronLeft size={16} />
        </button>
      </div>

      <div className="sidebar-section">
        <form onSubmit={handleSearch} className="search-row">
          <input
            className="text-input"
            placeholder="搜索地点 / POI..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {searchProviders.length > 1 && (
            <select
              className="select-input"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              title="搜索数据源"
            >
              <option value="auto">自动</option>
              {searchProviders.map((p) => (
                <option key={p} value={p}>
                  {p.toUpperCase()}
                </option>
              ))}
            </select>
          )}
          <button type="submit" className="btn primary" disabled={searching} title="搜索">
            <Search size={14} />
          </button>
        </form>

        {searchError && <div style={{ fontSize: 12, color: '#dc2626', marginTop: 6 }}>{searchError}</div>}

        {searchResults.length > 0 && (
          <div className="search-results">
            {searchResults.map((place, idx) => (
              <div
                key={`${place.lng}-${place.lat}-${idx}`}
                className="search-item"
                onClick={() => {
                  const bounds = place.boundary ? (geometryBounds(place.boundary) ?? undefined) : undefined;
                  onPreviewPlace(place, bounds);
                  if (window.innerWidth <= 768) {
                    setCollapsed(true);
                  }
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div className="search-item-title">
                    {place.name}
                    {place.boundary && (
                      <span className="badge editable" style={{ marginLeft: 6, fontSize: 10, padding: '1px 5px' }}>
                        含范围
                      </span>
                    )}
                  </div>
                  <div className="search-item-addr">{place.address || place.provider}</div>
                </div>
                {canEdit && (
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                    {place.boundary ? (
                      <>
                        <button
                          className="btn primary"
                          style={{ padding: '3px 7px', fontSize: 12 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            onAddPlaceMarker(place, true);
                          }}
                          title="按区域范围标注为多边形"
                        >
                          <Pentagon size={12} />
                          标范围
                        </button>
                        <button
                          className="btn outline"
                          style={{ padding: '3px 6px', fontSize: 12 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            onAddPlaceMarker(place, false);
                          }}
                          title="仅添加中心点标注"
                        >
                          <MapPin size={12} />
                        </button>
                      </>
                    ) : (
                      <button
                        className="btn outline"
                        style={{ padding: '3px 7px', fontSize: 12 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          onAddPlaceMarker(place, false);
                        }}
                        title="添加为点标注"
                      >
                        <Plus size={13} />
                        标注
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="sidebar-section" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          className="text-input"
          placeholder={`筛选标注（共 ${features.length} 条）...`}
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />
      </div>

      <div className="feature-list">
        {visibleList.length === 0 ? (
          <div style={{ padding: 18, textAlign: 'center', color: '#64748b', fontSize: 13 }}>
            暂无标注。{canEdit ? '使用顶部工具栏打点、画线或搜索添加。' : ''}
          </div>
        ) : (
          visibleList.map((f) => (
            <div
              key={f.id}
              className={`feature-item ${f.id === selectedFeatureId ? 'selected' : ''}`}
              onClick={() => {
                onSelectFeature(f.id);
                if (window.innerWidth <= 768) {
                  setCollapsed(true);
                }
              }}
            >
              <span className="color-dot" style={{ background: f.color || '#2563eb' }} />
              <span style={{ color: '#64748b', display: 'flex' }}>{featureIcon(f.geometry.type)}</span>
              <div className="feature-meta">
                <div className="feature-title">{f.title || '未命名标注'}</div>
                {f.category && <div className="feature-sub">[{f.category}]</div>}
                <div className="feature-sub" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {featureSummary(f)}
                </div>
              </div>
              {canEdit && (
                <button
                  className="btn"
                  style={{ padding: 4 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleVisible(f);
                  }}
                  title={f.visible ? '隐藏' : '显示'}
                >
                  {f.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
