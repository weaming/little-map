import { useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Eye,
  EyeOff,
  MapPin,
  Pentagon,
  Plus,
  RefreshCw,
  Search,
  Spline,
  X,
} from 'lucide-react';
import { searchPlaces, type SearchPlaceOptions } from '../api/client';
import { formatArea, formatDistance, lineLengthMeters, polygonAreaSqMeters } from '../map/geo';
import type {
  BeikeCluster,
  BeikeHouse,
  BeikeSearchResult,
  MapFeature,
  MapMeta,
  PlaceResult,
} from '../types/map';
import { BeikePanel } from './BeikePanel';

const POI_HISTORY_KEY = 'little_map_poi_search_history_v1';
const MAX_POI_HISTORY = 20;

function loadPoiHistory(): string[] {
  try {
    const raw = localStorage.getItem(POI_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
  } catch {
    return [];
  }
}

function savePoiHistory(list: string[]) {
  try {
    localStorage.setItem(POI_HISTORY_KEY, JSON.stringify(list.slice(0, MAX_POI_HISTORY)));
  } catch {
    // 忽略存储异常
  }
}

interface SidebarProps {
  mapMeta: MapMeta;
  features: MapFeature[];
  selectedFeatureId: string | null;
  canEdit: boolean;
  isSyncing: boolean;
  hasBeike: boolean;
  hasAmapKey: boolean;
  searchProviders: string[];
  searchResults: PlaceResult[];
  activeSearchIndex: number | null;
  beikeHouses: BeikeHouse[];
  beikeClusters: BeikeCluster[];
  beikeMeta: Omit<BeikeSearchResult, 'houses'> | null;
  activeBeikeClusterKey: string | null;
  beikeViewportOnly: boolean;
  beikeKeyword: string;
  beikeBizcircles: string[];
  beikeCopyWithPhotos: boolean;
  onBeikeViewportOnlyChange: (next: boolean) => void;
  onBeikeKeywordChange: (next: string) => void;
  onBeikeBizcirclesChange: (next: string[]) => void;
  onBeikeCopyWithPhotosChange: (next: boolean) => void;
  onBeikeCopyCSV: (houses: BeikeHouse[]) => void;
  onBeikeResultsReplace: (res: BeikeSearchResult) => void;
  onBeikeResultsAppend: (res: BeikeSearchResult) => void;
  onBeikeClear: () => void;
  onSelectBeikeCluster: (key: string) => void;
  getSearchOptions: () => SearchPlaceOptions;
  onRenameMap: (title: string) => void;
  onRefresh: () => void;
  onSelectFeature: (id: string) => void;
  onToggleVisible: (feature: MapFeature) => void;
  onSearchResults: (results: PlaceResult[]) => void;
  onClearSearch: () => void;
  onSelectSearchResult: (index: number) => void;
  onAddPlaceMarker: (place: PlaceResult, asPolygon?: boolean) => void;
}

export function Sidebar({
  mapMeta,
  features,
  selectedFeatureId,
  canEdit,
  isSyncing,
  hasBeike,
  hasAmapKey,
  searchProviders,
  searchResults,
  activeSearchIndex,
  beikeHouses,
  beikeClusters,
  beikeMeta,
  activeBeikeClusterKey,
  beikeViewportOnly,
  beikeKeyword,
  beikeBizcircles,
  beikeCopyWithPhotos,
  onBeikeViewportOnlyChange,
  onBeikeKeywordChange,
  onBeikeBizcirclesChange,
  onBeikeCopyWithPhotosChange,
  onBeikeCopyCSV,
  onBeikeResultsReplace,
  onBeikeResultsAppend,
  onBeikeClear,
  onSelectBeikeCluster,
  getSearchOptions,
  onRenameMap,
  onRefresh,
  onSelectFeature,
  onToggleVisible,
  onSearchResults,
  onClearSearch,
  onSelectSearchResult,
  onAddPlaceMarker,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth <= 768 : false,
  );
  const [activeTab, setActiveTab] = useState<'features' | 'beike'>('features');
  const [titleDraft, setTitleDraft] = useState(mapMeta.title);
  const [filterText, setFilterText] = useState('');

  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('auto');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searchHistory, setSearchHistory] = useState<string[]>(() => loadPoiHistory());

  // 当远端刷新标题时同步输入框
  if (titleDraft !== mapMeta.title && document.activeElement?.getAttribute('data-role') !== 'map-title') {
    setTitleDraft(mapMeta.title);
  }

  function recordSearchHistory(term: string) {
    setSearchHistory((prev) => {
      const next = [term, ...prev.filter((x) => x !== term)].slice(0, MAX_POI_HISTORY);
      savePoiHistory(next);
      return next;
    });
  }

  function removeHistoryItem(term: string) {
    setSearchHistory((prev) => {
      const next = prev.filter((x) => x !== term);
      savePoiHistory(next);
      return next;
    });
  }

  function clearHistory() {
    setSearchHistory([]);
    savePoiHistory([]);
  }

  function handleClearSearch() {
    setQuery('');
    setSearchError('');
    onClearSearch();
  }

  async function runPoiSearch(rawQuery: string) {
    const trimmed = rawQuery.trim();
    if (!trimmed) {
      handleClearSearch();
      return;
    }
    recordSearchHistory(trimmed);
    setSearching(true);
    setSearchError('');
    try {
      const resp = await searchPlaces(trimmed, provider, 20, getSearchOptions());
      onSearchResults(resp.results);
      if (resp.results.length === 0) {
        setSearchError('未找到匹配地点');
      }
    } catch {
      setSearchError('搜索服务暂时不可用');
      onClearSearch();
    } finally {
      setSearching(false);
    }
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    await runPoiSearch(query);
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

      {hasBeike && (
        <div className="sidebar-tabs">
          <button
            type="button"
            className={`sidebar-tab ${activeTab === 'features' ? 'active' : ''}`}
            onClick={() => setActiveTab('features')}
          >
            标注与搜索 ({features.length})
          </button>
          <button
            type="button"
            className={`sidebar-tab ${activeTab === 'beike' ? 'active' : ''}`}
            onClick={() => setActiveTab('beike')}
          >
            贝壳找房{beikeHouses.length > 0 ? ` (${beikeHouses.length})` : ''}
          </button>
        </div>
      )}

      {activeTab === 'beike' && hasBeike ? (
        <BeikePanel
          houses={beikeHouses}
          clusters={beikeClusters}
          meta={beikeMeta}
          activeClusterKey={activeBeikeClusterKey}
          viewportOnly={beikeViewportOnly}
          localKeyword={beikeKeyword}
          selectedBizcircles={beikeBizcircles}
          copyWithPhotos={beikeCopyWithPhotos}
          hasAmapKey={hasAmapKey}
          getViewportCenter={() => getSearchOptions().center ?? [mapMeta.center_lng, mapMeta.center_lat]}
          onViewportOnlyChange={onBeikeViewportOnlyChange}
          onLocalKeywordChange={onBeikeKeywordChange}
          onSelectedBizcirclesChange={onBeikeBizcirclesChange}
          onCopyWithPhotosChange={onBeikeCopyWithPhotosChange}
          onCopyCSV={onBeikeCopyCSV}
          onResultsReplace={onBeikeResultsReplace}
          onResultsAppend={onBeikeResultsAppend}
          onClear={onBeikeClear}
          onSelectCluster={(key) => {
            onSelectBeikeCluster(key);
            if (window.innerWidth <= 768) {
              setCollapsed(true);
            }
          }}
        />
      ) : (
        <>
      <div className="sidebar-section">
        <form onSubmit={handleSearch} className="search-row">
          <div className="search-input-wrap">
            <input
              list="poi-search-history-list"
              className="text-input"
              placeholder="搜索当前视图或附近 POI..."
              value={query}
              onChange={(e) => {
                const next = e.target.value;
                setQuery(next);
                if (!next.trim()) {
                  setSearchError('');
                  onClearSearch();
                }
              }}
            />
            <datalist id="poi-search-history-list">
              {searchHistory.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
            {(query.length > 0 || searchResults.length > 0) && (
              <button
                type="button"
                className="search-clear-btn"
                onClick={handleClearSearch}
                title="清除搜索"
                aria-label="清除搜索"
              >
                <X size={14} />
              </button>
            )}
          </div>
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

        {searchResults.length === 0 && searchHistory.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div className="search-results-header" style={{ marginTop: 0, marginBottom: 5 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Clock size={11} />
                最近搜索 ({searchHistory.length})
              </span>
              <button
                type="button"
                className="btn"
                style={{ padding: '1px 5px', fontSize: 11 }}
                onClick={clearHistory}
              >
                清空
              </button>
            </div>
            <div className="beike-presets">
              {searchHistory.map((item) => (
                <span
                  key={item}
                  className="beike-preset-pill"
                  onClick={() => {
                    setQuery(item);
                    void runPoiSearch(item);
                  }}
                  title={`再次搜索「${item}」`}
                >
                  <span className="beike-preset-name">{item}</span>
                  <button
                    type="button"
                    className="beike-preset-del"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeHistoryItem(item);
                    }}
                    title="移除该记录"
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}

        {searchResults.length > 0 && (
          <>
            <div className="search-results-header">
              <span>共 {searchResults.length} 个结果（已显示在地图）</span>
              <button type="button" className="btn" style={{ padding: '2px 6px', fontSize: 11.5 }} onClick={handleClearSearch}>
                清除结果
              </button>
            </div>
            <div className="search-results">
              {searchResults.map((place, idx) => (
                <div
                  key={`${place.lng}-${place.lat}-${idx}`}
                  className={`search-item ${idx === activeSearchIndex ? 'active' : ''}`}
                  onClick={() => {
                    onSelectSearchResult(idx);
                    if (window.innerWidth <= 768) {
                      setCollapsed(true);
                    }
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, minWidth: 0 }}>
                    <span className={`search-item-index ${idx === activeSearchIndex ? 'active' : ''}`}>
                      {idx + 1}
                    </span>
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
          </>
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
        </>
      )}
    </aside>
  );
}
