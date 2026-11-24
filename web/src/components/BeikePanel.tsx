import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookmarkPlus,
  ChevronDown,
  ChevronUp,
  Copy,
  Home,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import {
  extractErrorMessage,
  fetchBeikeCities,
  fetchBeikeRegions,
  reverseGeocode,
  searchBeikeRent,
} from '../api/client';
import { haversineMeters } from '../map/geo';
import type {
  BeikeCity,
  BeikeCluster,
  BeikeHouse,
  BeikeRegion,
  BeikeSearchParams,
  BeikeSearchResult,
} from '../types/map';

const FILTER_STORAGE_KEY = 'little_map_beike_filters_v1';
const PRESETS_STORAGE_KEY = 'little_map_beike_presets_v1';
const RESULT_CACHE_KEY = 'little_map_beike_cache_v1';
const RESULT_CACHE_TTL_MS = 10 * 60 * 1000;
const RESULT_CACHE_MAX_ENTRIES = 12;

// 常用大城市优先置顶顺序（城市 ID）
const POPULAR_CITY_IDS = [
  '110000', // 北京
  '310000', // 上海
  '440300', // 深圳
  '440100', // 广州
  '330100', // 杭州
  '510100', // 成都
  '320100', // 南京
  '420100', // 武汉
  '500000', // 重庆
  '610100', // 西安
  '120000', // 天津
  '320500', // 苏州
  '430100', // 长沙
  '410100', // 郑州
  '370200', // 青岛
  '350200', // 厦门
  '340100', // 合肥
  '441900', // 东莞
  '440600', // 佛山
  '330200', // 宁波
  '441300', // 惠州
  '440400', // 珠海
];

// 无高德逆地理 Key 时，按视图中心 WGS-84 坐标兜底匹配最近常用城市
const MAJOR_CITY_CENTERS: Array<{ id: string; lng: number; lat: number }> = [
  { id: '110000', lng: 116.4074, lat: 39.9042 },
  { id: '310000', lng: 121.4737, lat: 31.2304 },
  { id: '440300', lng: 114.0579, lat: 22.5431 },
  { id: '440100', lng: 113.2644, lat: 23.1291 },
  { id: '330100', lng: 120.1551, lat: 30.2741 },
  { id: '510100', lng: 104.0668, lat: 30.5728 },
  { id: '320100', lng: 118.7969, lat: 32.0603 },
  { id: '420100', lng: 114.3055, lat: 30.5928 },
  { id: '500000', lng: 106.5516, lat: 29.563 },
  { id: '610100', lng: 108.9398, lat: 34.3416 },
  { id: '120000', lng: 117.201, lat: 39.0842 },
  { id: '320500', lng: 120.5853, lat: 31.2989 },
  { id: '430100', lng: 112.9388, lat: 28.2282 },
  { id: '410100', lng: 113.6254, lat: 34.7466 },
  { id: '370200', lng: 120.3826, lat: 36.0671 },
  { id: '350200', lng: 118.0894, lat: 24.4798 },
  { id: '340100', lng: 117.2272, lat: 31.8206 },
  { id: '441900', lng: 113.7518, lat: 23.0207 },
  { id: '440600', lng: 113.1214, lat: 23.0215 },
  { id: '330200', lng: 121.544, lat: 29.8683 },
  { id: '441300', lng: 114.4168, lat: 23.1118 },
  { id: '440400', lng: 113.5767, lat: 22.2707 },
];

const QUICK_FEATURES: Array<{ key: string; label: string }> = [
  { key: 'subway', label: '近地铁' },
  { key: 'elevator', label: '有电梯' },
  { key: 'decoration', label: '精装修' },
  { key: 'private_bath', label: '独卫' },
  { key: 'balcony', label: '独立阳台' },
  { key: 'south', label: '朝南' },
  { key: 'southeast', label: '朝东南' },
  { key: 'southwest', label: '朝西南' },
  { key: 'north_south', label: '南北' },
  { key: 'one_pay_one', label: '押一付一' },
  { key: 'monthly', label: '月租' },
  { key: 'new', label: '新上' },
  { key: 'ready_to_move', label: '拎包入住' },
  { key: 'anytime_view', label: '随时看房' },
];

const EXTRA_FEATURES: Array<{ key: string; label: string }> = [
  { key: 'worry_free', label: '省心租' },
  { key: 'two_bath', label: '双卫' },
  { key: 'central_heating', label: '集中供暖' },
  { key: 'certified_apt', label: '认证公寓' },
  { key: 'vr', label: 'VR房源' },
  { key: 'no_elevator', label: '无电梯' },
];

const LEASE_FEATURES: Array<{ key: string; label: string }> = [
  { key: 'yearly', label: '年租' },
  { key: 'month_from_now', label: '1个月起租' },
  { key: 'short_1_3', label: '1-3个月' },
  { key: 'short_4_6', label: '4-6个月' },
];

const ORIENTATION_FEATURES: Array<{ key: string; label: string }> = [
  { key: 'east', label: '朝东' },
  { key: 'west', label: '朝西' },
  { key: 'north', label: '朝北' },
  { key: 'northeast', label: '朝东北' },
  { key: 'northwest', label: '朝西北' },
];

// 结果区优先展示的高价值房源标签（服务端无直接筛选 token，适合本地一键组合过滤）
const VALUABLE_RESULT_TAGS = [
  '民水民电',
  '可养宠物',
  '免中介费',
  '同区低价',
  '近期降价',
  '月付',
  '首次出租',
  '有车位',
  '全南朝向',
  '钻石好房',
  '必看好房',
  '优选好房',
  '官方核验',
  '开放厨房',
  '双卫生间',
  'VR看房',
  '业主自荐',
];

interface SavedFilters {
  city: string;
  priceMin: string;
  priceMax: string;
  rooms: number;
  rentType: 'any' | 'whole' | 'shared';
  region: string;
  metroLine: string;
  district: string;
  area: string;
  moveIn: string;
  floor: string;
  brand: string;
  sort: string;
  pages: number;
  selectedFeatures: string[];
}

interface FilterPreset {
  id: string;
  name: string;
  filters: SavedFilters;
}

const DEFAULT_FILTERS: SavedFilters = {
  city: '110000',
  priceMin: '',
  priceMax: '',
  rooms: 0,
  rentType: 'any',
  region: '',
  metroLine: '',
  district: '',
  area: '',
  moveIn: '',
  floor: '',
  brand: '',
  sort: 'price_asc',
  pages: 2,
  selectedFeatures: [],
};

function loadSavedFilters(): SavedFilters {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return DEFAULT_FILTERS;
    const parsed = JSON.parse(raw) as Partial<SavedFilters>;
    return {
      ...DEFAULT_FILTERS,
      ...parsed,
      selectedFeatures: Array.isArray(parsed.selectedFeatures) ? parsed.selectedFeatures : [],
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

function persistFilters(f: SavedFilters) {
  try {
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(f));
  } catch {
    // 忽略配额或隐私模式异常
  }
}

function loadPresets(): FilterPreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as FilterPreset[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePresets(list: FilterPreset[]) {
  try {
    localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(list.slice(0, 20)));
  } catch {
    // 忽略配额异常
  }
}

interface CacheEntry {
  ts: number;
  data: BeikeSearchResult;
}

function readCachedSearch(key: string): BeikeSearchResult | null {
  try {
    const raw = localStorage.getItem(RESULT_CACHE_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, CacheEntry>;
    const hit = map[key];
    if (!hit || Date.now() - hit.ts > RESULT_CACHE_TTL_MS) return null;
    return hit.data;
  } catch {
    return null;
  }
}

function writeCachedSearch(key: string, data: BeikeSearchResult) {
  try {
    const raw = localStorage.getItem(RESULT_CACHE_KEY);
    const map: Record<string, CacheEntry> = raw ? (JSON.parse(raw) as Record<string, CacheEntry>) : {};
    const now = Date.now();
    for (const [k, v] of Object.entries(map)) {
      if (now - v.ts > RESULT_CACHE_TTL_MS) delete map[k];
    }
    map[key] = { ts: now, data };
    const entries = Object.entries(map).sort((a, b) => b[1].ts - a[1].ts).slice(0, RESULT_CACHE_MAX_ENTRIES);
    localStorage.setItem(RESULT_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // 忽略 localStorage 写入异常
  }
}

function matchNearestMajorCity(center: [number, number], validCityIds: Set<string>): string | null {
  let bestId: string | null = null;
  let bestDist = 120_000; // 120km 内视为命中该城市
  for (const c of MAJOR_CITY_CENTERS) {
    if (!validCityIds.has(c.id)) continue;
    const d = haversineMeters(center[0], center[1], c.lng, c.lat);
    if (d < bestDist) {
      bestDist = d;
      bestId = c.id;
    }
  }
  return bestId;
}

interface BeikePanelProps {
  houses: BeikeHouse[];
  clusters: BeikeCluster[];
  meta: Omit<BeikeSearchResult, 'houses'> | null;
  activeClusterKey: string | null;
  viewportOnly: boolean;
  localKeyword: string;
  selectedBizcircles: string[];
  copyWithPhotos: boolean;
  hasAmapKey: boolean;
  getViewportCenter: () => [number, number];
  onViewportOnlyChange: (next: boolean) => void;
  onLocalKeywordChange: (next: string) => void;
  onSelectedBizcirclesChange: (next: string[]) => void;
  onCopyWithPhotosChange: (next: boolean) => void;
  onCopyCSV: (houses: BeikeHouse[]) => void;
  onResultsReplace: (res: BeikeSearchResult) => void;
  onResultsAppend: (res: BeikeSearchResult) => void;
  onClear: () => void;
  onSelectCluster: (key: string) => void;
}

export function BeikePanel({
  houses,
  clusters,
  meta,
  activeClusterKey,
  viewportOnly,
  localKeyword,
  selectedBizcircles,
  copyWithPhotos,
  hasAmapKey,
  getViewportCenter,
  onViewportOnlyChange,
  onLocalKeywordChange,
  onSelectedBizcirclesChange,
  onCopyWithPhotosChange,
  onCopyCSV,
  onResultsReplace,
  onResultsAppend,
  onClear,
  onSelectCluster,
}: BeikePanelProps) {
  const [cities, setCities] = useState<BeikeCity[]>([]);
  const [filters, setFilters] = useState<SavedFilters>(() => loadSavedFilters());
  const [presets, setPresets] = useState<FilterPreset[]>(() => loadPresets());
  const [regions, setRegions] = useState<BeikeRegion[]>([]);
  const [regionInput, setRegionInput] = useState('');
  const [regionDropdownOpen, setRegionDropdownOpen] = useState(false);
  const [regionFiltering, setRegionFiltering] = useState(false);
  const [metros, setMetros] = useState<BeikeRegion[]>([]);
  const [showMore, setShowMore] = useState(false);

  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [fromLocalCache, setFromLocalCache] = useState(false);
  const [error, setError] = useState('');

  const autoDetectedCityRef = useRef(false);
  const userTouchedCityRef = useRef(false);
  const lastSearchParamsRef = useRef<BeikeSearchParams | null>(null);

  useEffect(() => {
    persistFilters(filters);
  }, [filters]);

  useEffect(() => {
    void fetchBeikeCities()
      .then((list) => setCities(list))
      .catch(() => {});
  }, []);

  // 打开找房面板后，默认自动匹配当前地图视图所在城市（不覆盖用户手动切换或点选方案）
  useEffect(() => {
    if (cities.length === 0 || autoDetectedCityRef.current || userTouchedCityRef.current) return;
    autoDetectedCityRef.current = true;

    const center = getViewportCenter();
    const validIds = new Set(cities.map((c) => c.id));
    let cancelled = false;

    const applyDetectedCity = (cityId: string | null) => {
      if (cancelled || !cityId || userTouchedCityRef.current) return;
      setFilters((prev) =>
        prev.city === cityId
          ? prev
          : { ...prev, city: cityId, region: '', metroLine: '' },
      );
    };

    const fallbackToNearest = () => {
      applyDetectedCity(matchNearestMajorCity(center, validIds));
    };

    if (hasAmapKey) {
      void reverseGeocode(center[0], center[1])
        .then((place) => {
          const text = `${place?.address ?? ''} ${place?.name ?? ''}`;
          if (text.trim()) {
            // 按城市名长度倒序匹配，避免短名误匹配
            const sorted = [...cities].sort((a, b) => b.name.length - a.name.length);
            const hit = sorted.find((c) => c.name && text.includes(c.name));
            if (hit) {
              applyDetectedCity(hit.id);
              return;
            }
          }
          fallbackToNearest();
        })
        .catch(fallbackToNearest);
    } else {
      fallbackToNearest();
    }

    return () => {
      cancelled = true;
    };
  }, [cities, hasAmapKey, getViewportCenter]);

  useEffect(() => {
    void Promise.all([
      fetchBeikeRegions(filters.city, 'region').catch(() => ({ city_id: filters.city, regions: [] })),
      fetchBeikeRegions(filters.city, 'metro').catch(() => ({ city_id: filters.city, regions: [] })),
    ]).then(([regRes, metRes]) => {
      setRegions(regRes.regions);
      setMetros(metRes.regions);
    });
  }, [filters.city]);

  // 当内置区域列表加载或外部切换 region（如点选预设/重置）时同步可搜索输入框显示名
  useEffect(() => {
    if (!filters.region) {
      setRegionInput('');
      return;
    }
    const matched = regions.find((r) => r.token === filters.region);
    if (matched) {
      setRegionInput(matched.name);
    }
  }, [filters.region, regions]);

  const { popularCities, otherCities } = useMemo(() => {
    const byId = new Map(cities.map((c) => [c.id, c]));
    const popular: BeikeCity[] = [];
    const popSet = new Set<string>();
    for (const id of POPULAR_CITY_IDS) {
      const c = byId.get(id);
      if (c) {
        popular.push(c);
        popSet.add(id);
      }
    }
    const others = cities.filter((c) => !popSet.has(c.id));
    return { popularCities: popular, otherCities: others };
  }, [cities]);

  function updateFilter<K extends keyof SavedFilters>(key: K, value: SavedFilters[K]) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  function resolveRegionInput(raw: string): { regionToken: string; fallbackDistrict: string } {
    const trimmed = raw.trim();
    if (!trimmed) return { regionToken: '', fallbackDistrict: '' };
    const exact = regions.find((r) => r.name === trimmed || r.token === trimmed);
    if (exact) return { regionToken: exact.token, fallbackDistrict: '' };
    const partial = regions.find((r) => r.name.includes(trimmed));
    if (partial) return { regionToken: partial.token, fallbackDistrict: '' };
    return { regionToken: '', fallbackDistrict: trimmed };
  }

  function buildParams(startPage = 1): BeikeSearchParams {
    const pMin = Number(filters.priceMin);
    const pMax = Number(filters.priceMax);
    let regionToken = filters.region;
    let districtVal = filters.district.trim();
    if (regions.length > 0 && regionInput.trim() && !regionToken) {
      const resolved = resolveRegionInput(regionInput);
      regionToken = resolved.regionToken;
      if (!districtVal && resolved.fallbackDistrict) {
        districtVal = resolved.fallbackDistrict;
      }
    }
    return {
      city: filters.city,
      ...(Number.isFinite(pMin) && pMin > 0 ? { price_min: Math.round(pMin) } : {}),
      ...(Number.isFinite(pMax) && pMax > 0 ? { price_max: Math.round(pMax) } : {}),
      ...(filters.rooms > 0 ? { rooms: filters.rooms } : {}),
      rent_type: filters.rentType,
      ...(regionToken ? { region: regionToken } : {}),
      ...(filters.metroLine ? { metro_line: filters.metroLine } : {}),
      ...(districtVal ? { district: districtVal } : {}),
      ...(filters.area ? { area: filters.area } : {}),
      ...(filters.moveIn ? { move_in: filters.moveIn } : {}),
      ...(filters.floor ? { floor: filters.floor } : {}),
      ...(filters.brand ? { brand: filters.brand } : {}),
      ...(filters.selectedFeatures.length > 0 ? { features: [...filters.selectedFeatures].sort() } : {}),
      sort: filters.sort,
      pages: filters.pages,
      start_page: startPage,
    };
  }

  async function executeSearch(skipCache = false) {
    const params = buildParams(1);
    lastSearchParamsRef.current = params;
    const cacheKey = JSON.stringify(params);
    setError('');

    if (!skipCache) {
      const cached = readCachedSearch(cacheKey);
      if (cached) {
        setFromLocalCache(true);
        onResultsReplace(cached);
        if (cached.houses.length === 0) {
          setError('未找到符合条件的房源，可放宽条件重试');
        }
        return;
      }
    }

    setLoading(true);
    setFromLocalCache(false);
    try {
      const res = await searchBeikeRent(skipCache ? { ...params, no_cache: true } : params);
      writeCachedSearch(cacheKey, res);
      onResultsReplace(res);
      if (res.houses.length === 0) {
        setError('未找到符合条件的房源，可放宽价格或区域条件重试');
      }
    } catch (err) {
      setError(extractErrorMessage(err).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    await executeSearch(false);
  }

  async function handleLoadMore() {
    if (!meta?.next_page || loadingMore) return;
    const base = lastSearchParamsRef.current ?? buildParams(1);
    const params: BeikeSearchParams = { ...base, start_page: meta.next_page };
    setError('');
    setLoadingMore(true);
    try {
      const res = await searchBeikeRent(params);
      onResultsAppend(res);
    } catch (err) {
      setError(extractErrorMessage(err).message);
    } finally {
      setLoadingMore(false);
    }
  }

  function handleSavePreset() {
    const cityName = cities.find((c) => c.id === filters.city)?.name || filters.city;
    const regName = regions.find((r) => r.token === filters.region)?.name || filters.district.trim();
    const pricePart =
      filters.priceMin || filters.priceMax
        ? `${filters.priceMin || '0'}-${filters.priceMax || '不限'}元`
        : '';
    const roomPart = filters.rooms > 0 ? `${filters.rooms}居` : '';
    const rentPart = filters.rentType === 'whole' ? '整租' : filters.rentType === 'shared' ? '合租' : '';
    const autoName = [cityName, regName, pricePart, roomPart, rentPart].filter(Boolean).join('·') || cityName;

    const input = window.prompt('保存当前搜索条件为快捷方案：', autoName);
    if (input === null) return;
    const name = input.trim() || autoName;
    const next: FilterPreset[] = [
      {
        id: `p_${Date.now()}`,
        name,
        filters: { ...filters, selectedFeatures: [...filters.selectedFeatures] },
      },
      ...presets.filter((p) => p.name !== name),
    ].slice(0, 20);
    setPresets(next);
    savePresets(next);
  }

  function handleApplyPreset(preset: FilterPreset) {
    userTouchedCityRef.current = true;
    setFilters({
      ...DEFAULT_FILTERS,
      ...preset.filters,
      selectedFeatures: [...preset.filters.selectedFeatures],
    });
  }

  function handleDeletePreset(id: string) {
    const next = presets.filter((p) => p.id !== id);
    setPresets(next);
    savePresets(next);
  }

  function toggleFeature(key: string) {
    setFilters((prev) => ({
      ...prev,
      selectedFeatures: prev.selectedFeatures.includes(key)
        ? prev.selectedFeatures.filter((k) => k !== key)
        : [...prev.selectedFeatures, key],
    }));
  }

  const filteredRegions = useMemo(() => {
    const kw = regionFiltering ? regionInput.trim().toLowerCase() : '';
    if (!kw) return regions;
    return regions.filter(
      (r) => r.name.toLowerCase().includes(kw) || r.token.toLowerCase().includes(kw),
    );
  }, [regions, regionInput, regionFiltering]);

  const bizcircleStats = useMemo(() => {
    const counts = new Map<string, number>();
    for (const h of houses) {
      const biz = (h.bizcircle || '').trim();
      if (!biz) continue;
      counts.set(biz, (counts.get(biz) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
  }, [houses]);

  const resultTagStats = useMemo(() => {
    const counts = new Map<string, number>();
    for (const h of houses) {
      for (const t of h.tags) {
        const name = t.trim();
        if (!name) continue;
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    const ranked: Array<[string, number]> = [];
    for (const name of VALUABLE_RESULT_TAGS) {
      const cnt = counts.get(name);
      if (cnt && cnt > 0) {
        ranked.push([name, cnt]);
      }
    }
    return ranked.slice(0, 12);
  }, [houses]);

  const activeLocalTerms = useMemo(
    () => new Set(localKeyword.trim().split(/\s+/).filter(Boolean)),
    [localKeyword],
  );

  function toggleLocalTerm(term: string) {
    const parts = localKeyword.trim().split(/\s+/).filter(Boolean);
    const next = parts.includes(term) ? parts.filter((p) => p !== term) : [...parts, term];
    onLocalKeywordChange(next.join(' '));
  }

  function toggleBizcircle(biz: string) {
    const next = selectedBizcircles.includes(biz)
      ? selectedBizcircles.filter((b) => b !== biz)
      : [...selectedBizcircles, biz];
    onSelectedBizcirclesChange(next);
  }

  const extraActiveCount =
    (filters.area ? 1 : 0) +
    (filters.moveIn ? 1 : 0) +
    (filters.floor ? 1 : 0) +
    (filters.brand ? 1 : 0) +
    filters.selectedFeatures.filter((k) => !QUICK_FEATURES.some((q) => q.key === k)).length;

  return (
    <div className="beike-panel">
      <form onSubmit={handleSearch} className="beike-form">
        {presets.length > 0 && (
          <div className="beike-presets">
            {presets.map((preset) => (
              <span
                key={preset.id}
                className="beike-preset-pill"
                onClick={() => handleApplyPreset(preset)}
                title="点击一键填入该筛选条件"
              >
                <span className="beike-preset-name">{preset.name}</span>
                <button
                  type="button"
                  className="beike-preset-del"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeletePreset(preset.id);
                  }}
                  title="删除该方案"
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="beike-grid-2">
          <select
            className="select-input"
            value={filters.city}
            onChange={(e) => {
              userTouchedCityRef.current = true;
              setFilters((prev) => ({
                ...prev,
                city: e.target.value,
                region: '',
                metroLine: '',
              }));
            }}
            title="选择城市（默认自动选中当前视图所在城市）"
          >
            {cities.length === 0 ? (
              <option value="110000">北京</option>
            ) : (
              <>
                {popularCities.length > 0 && (
                  <optgroup label="常用城市">
                    {popularCities.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {otherCities.length > 0 && (
                  <optgroup label="全部城市">
                    {otherCities.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </>
            )}
          </select>

          <select
            className="select-input"
            value={filters.sort}
            onChange={(e) => updateFilter('sort', e.target.value)}
            title="排序方式"
          >
            <option value="price_asc">价格低→高</option>
            <option value="price_desc">价格高→低</option>
            <option value="newest">最新发布</option>
            <option value="area_desc">面积大→小</option>
            <option value="area_asc">面积小→大</option>
            <option value="default">综合排序</option>
          </select>
        </div>

        <div className="beike-grid-2">
          <input
            type="number"
            min={0}
            step={100}
            className="text-input compact-input"
            placeholder="最低租金(元)"
            value={filters.priceMin}
            onChange={(e) => updateFilter('priceMin', e.target.value)}
          />
          <input
            type="number"
            min={0}
            step={100}
            className="text-input compact-input"
            placeholder="最高租金(元)"
            value={filters.priceMax}
            onChange={(e) => updateFilter('priceMax', e.target.value)}
          />
        </div>

        <div className="beike-grid-2">
          <select
            className="select-input"
            value={filters.rooms}
            onChange={(e) => updateFilter('rooms', Number(e.target.value))}
          >
            <option value={0}>居室不限</option>
            <option value={1}>1 居</option>
            <option value={2}>2 居</option>
            <option value={3}>3 居</option>
            <option value={4}>4 居及以上</option>
          </select>

          <select
            className="select-input"
            value={filters.rentType}
            onChange={(e) => updateFilter('rentType', e.target.value as 'any' | 'whole' | 'shared')}
          >
            <option value="any">整/合租不限</option>
            <option value="whole">整租</option>
            <option value="shared">合租</option>
          </select>
        </div>

        {regions.length > 0 || metros.length > 0 ? (
          <div className="beike-grid-2">
            <div className="search-input-wrap" style={{ position: 'relative' }}>
              <input
                className="text-input compact-input"
                placeholder={regions.length > 0 ? '搜区域/商圈(如望京)' : '暂无内置商圈'}
                disabled={regions.length === 0}
                value={regionInput}
                onFocus={() => {
                  setRegionDropdownOpen(true);
                  setRegionFiltering(false);
                }}
                onClick={() => {
                  setRegionDropdownOpen(true);
                  setRegionFiltering(false);
                }}
                onChange={(e) => {
                  const val = e.target.value;
                  setRegionInput(val);
                  setRegionFiltering(true);
                  setRegionDropdownOpen(true);
                  const exact = regions.find((r) => r.name === val.trim());
                  updateFilter('region', exact ? exact.token : '');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setRegionDropdownOpen(false);
                  }
                }}
                onBlur={() => {
                  setRegionDropdownOpen(false);
                  setRegionFiltering(false);
                  if (!regionInput.trim()) {
                    updateFilter('region', '');
                    return;
                  }
                  const exact = regions.find((r) => r.name === regionInput.trim());
                  if (exact) {
                    updateFilter('region', exact.token);
                  }
                }}
              />
              {regionInput && (
                <button
                  type="button"
                  className="search-clear-btn"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setRegionInput('');
                    setRegionFiltering(false);
                    updateFilter('region', '');
                  }}
                  title="清除区域"
                >
                  <X size={12} />
                </button>
              )}
              {regionDropdownOpen && regions.length > 0 && (
                <div className="beike-region-dropdown">
                  <button
                    type="button"
                    className={`beike-region-option ${!filters.region ? 'active' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setRegionInput('');
                      setRegionFiltering(false);
                      updateFilter('region', '');
                      setRegionDropdownOpen(false);
                    }}
                  >
                    区域/商圈不限
                  </button>
                  {filteredRegions.length === 0 ? (
                    <div className="beike-region-empty">无匹配内置商圈，搜索时将按区县过滤</div>
                  ) : (
                    filteredRegions.slice(0, 80).map((r) => (
                      <button
                        key={r.token}
                        type="button"
                        className={`beike-region-option ${filters.region === r.token ? 'active' : ''}`}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setRegionInput(r.name);
                          setRegionFiltering(false);
                          updateFilter('region', r.token);
                          setRegionDropdownOpen(false);
                        }}
                      >
                        {r.name}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            <select
              className="select-input"
              value={filters.metroLine}
              onChange={(e) => updateFilter('metroLine', e.target.value)}
              disabled={metros.length === 0}
            >
              <option value="">地铁线不限</option>
              {metros.map((m) => (
                <option key={m.token} value={m.token}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <input
            className="text-input compact-input"
            placeholder="区县关键词（如：惠阳、南山）"
            value={filters.district}
            onChange={(e) => updateFilter('district', e.target.value)}
          />
        )}

        <div className="beike-chips">
          {QUICK_FEATURES.map((f) => {
            const active = filters.selectedFeatures.includes(f.key);
            return (
              <button
                key={f.key}
                type="button"
                className={`beike-chip ${active ? 'active' : ''}`}
                onClick={() => toggleFeature(f.key)}
              >
                {f.label}
              </button>
            );
          })}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
          <button
            type="button"
            className="beike-more-toggle"
            onClick={() => setShowMore((v) => !v)}
          >
            <SlidersHorizontal size={12} />
            更多筛选{extraActiveCount > 0 ? ` (${extraActiveCount})` : ''}
            {showMore ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className="beike-more-toggle"
              onClick={handleSavePreset}
              title="保存当前筛选条件，下次一键填入"
            >
              <BookmarkPlus size={12} />
              保存条件
            </button>
            <button
              type="button"
              className="beike-more-toggle"
              onClick={() => setFilters({ ...DEFAULT_FILTERS, city: filters.city })}
              title="重置当前城市筛选条件"
            >
              <RotateCcw size={11} />
              重置
            </button>
          </div>
        </div>

        {showMore && (
          <div className="beike-more-box">
            <div className="beike-grid-2">
              <select
                className="select-input"
                value={filters.area}
                onChange={(e) => updateFilter('area', e.target.value)}
                title="面积"
              >
                <option value="">面积不限</option>
                <option value="ra0">≤40㎡</option>
                <option value="ra1">40-60㎡</option>
                <option value="ra2">60-80㎡</option>
                <option value="ra3">80-100㎡</option>
                <option value="ra4">100-120㎡</option>
                <option value="ra5">≥120㎡</option>
              </select>

              <select
                className="select-input"
                value={filters.moveIn}
                onChange={(e) => updateFilter('moveIn', e.target.value)}
                title="可入住时间"
              >
                <option value="">入住时间不限</option>
                <option value="rtp5">5天内可住</option>
                <option value="rtp10">10天内可住</option>
                <option value="rtp15">15天内可住</option>
                <option value="rtp20">20天内可住</option>
                <option value="rtp30">30天内可住</option>
              </select>
            </div>

            <div className="beike-grid-2">
              <select
                className="select-input"
                value={filters.floor}
                onChange={(e) => updateFilter('floor', e.target.value)}
                title="楼层"
              >
                <option value="">楼层不限</option>
                <option value="lc200500000003">低楼层</option>
                <option value="lc200500000002">中楼层</option>
                <option value="lc200500000001">高楼层</option>
              </select>

              <select
                className="select-input"
                value={filters.brand}
                onChange={(e) => updateFilter('brand', e.target.value)}
                title="品牌"
              >
                <option value="">品牌不限</option>
                <option value="ab200301001000">链家</option>
                <option value="ab200302002000">自如</option>
              </select>
            </div>

            <div className="beike-grid-2">
              <input
                className="text-input compact-input"
                placeholder="区县模糊过滤"
                value={filters.district}
                onChange={(e) => updateFilter('district', e.target.value)}
              />

              <select
                className="select-input"
                value={filters.pages}
                onChange={(e) => updateFilter('pages', Number(e.target.value))}
                title="单次查询翻页深度"
              >
                <option value={1}>每次查 1 页 (~30套)</option>
                <option value={2}>每次查 2 页 (~60套)</option>
                <option value={3}>每次查 3 页 (~90套)</option>
                <option value={5}>每次查 5 页 (~150套)</option>
              </select>
            </div>

            <div className="beike-more-label">租期</div>
            <div className="beike-chips">
              {LEASE_FEATURES.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className={`beike-chip ${filters.selectedFeatures.includes(f.key) ? 'active' : ''}`}
                  onClick={() => toggleFeature(f.key)}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <div className="beike-more-label">朝向</div>
            <div className="beike-chips">
              {ORIENTATION_FEATURES.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className={`beike-chip ${filters.selectedFeatures.includes(f.key) ? 'active' : ''}`}
                  onClick={() => toggleFeature(f.key)}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <div className="beike-more-label">更多亮点</div>
            <div className="beike-chips">
              {EXTRA_FEATURES.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className={`beike-chip ${filters.selectedFeatures.includes(f.key) ? 'active' : ''}`}
                  onClick={() => toggleFeature(f.key)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="submit"
            className="btn primary"
            style={{ flex: 1, justifyContent: 'center' }}
            disabled={loading}
          >
            <Search size={14} />
            {loading ? '搜索中...' : '搜索房源'}
          </button>
          {houses.length > 0 && (
            <button
              type="button"
              className="btn outline"
              onClick={() => void executeSearch(true)}
              disabled={loading}
              title="跳过本地缓存重新拉取"
            >
              <RotateCcw size={13} />
            </button>
          )}
          {houses.length > 0 && (
            <button
              type="button"
              className="btn outline"
              onClick={() => {
                setError('');
                setFromLocalCache(false);
                onClear();
              }}
              title="清除房源"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </form>

      {error && <div style={{ fontSize: 12, color: '#dc2626', padding: '0 14px 8px' }}>{error}</div>}

      {houses.length > 0 && (
        <>
          <div className="beike-summary-bar" style={{ flexWrap: 'wrap', gap: 6 }}>
            <span>
              {clusters.length} 小区 · {clusters.reduce((acc, c) => acc + c.houses.length, 0)}/{houses.length} 套
              {fromLocalCache ? ' (缓存)' : ''}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {meta && (meta.next_page ?? 0) > 0 && (
                <button
                  type="button"
                  className="btn outline"
                  style={{ padding: '2px 7px', fontSize: 11.5 }}
                  disabled={loadingMore}
                  onClick={() => void handleLoadMore()}
                  title={`继续加载第 ${meta.next_page} 页${meta.remaining_pages ? `（还剩 ${meta.remaining_pages} 页）` : ''}`}
                >
                  {loadingMore ? '加载中...' : `+ 第${meta.next_page}页`}
                </button>
              )}
              {clusters.length > 0 && (
                <>
                  <button
                    type="button"
                    className="btn outline"
                    style={{ padding: '2px 7px', fontSize: 11.5 }}
                    onClick={() => onCopyCSV(clusters.flatMap((c) => c.houses))}
                    title="复制当前筛选结果的 CSV（给 AI 分析）"
                  >
                    <Copy size={11} />
                    复制CSV
                  </button>
                  <label className="beike-viewport-toggle" title="复制 CSV 时在最后一列附带图片 URL">
                    <input
                      type="checkbox"
                      checked={copyWithPhotos}
                      onChange={(e) => onCopyWithPhotosChange(e.target.checked)}
                    />
                    含图
                  </label>
                </>
              )}
              <label className="beike-viewport-toggle">
                <input
                  type="checkbox"
                  checked={viewportOnly}
                  onChange={(e) => onViewportOnlyChange(e.target.checked)}
                />
                视口内
              </label>
            </div>
          </div>
          <div className="beike-local-filter">
            <div className="search-input-wrap">
              <input
                className="text-input compact-input"
                placeholder="筛选结果：小区 / 商圈 / 地铁 / 标题 / 标签（空格多词）"
                value={localKeyword}
                onChange={(e) => onLocalKeywordChange(e.target.value)}
              />
              {localKeyword && (
                <button
                  type="button"
                  className="search-clear-btn"
                  onClick={() => onLocalKeywordChange('')}
                  title="清空筛选"
                >
                  <X size={13} />
                </button>
              )}
            </div>
            {bizcircleStats.length > 0 && (
              <div className="beike-chips" style={{ marginTop: 6 }}>
                {bizcircleStats.map(([biz, cnt]) => {
                  const active = selectedBizcircles.includes(biz);
                  return (
                    <button
                      key={biz}
                      type="button"
                      className={`beike-chip ${active ? 'active' : ''}`}
                      onClick={() => toggleBizcircle(biz)}
                      title="多选商圈为「或」关系"
                    >
                      {biz} ({cnt})
                    </button>
                  );
                })}
              </div>
            )}
            {resultTagStats.length > 0 && (
              <div className="beike-chips" style={{ marginTop: 5 }}>
                {resultTagStats.map(([tag, cnt]) => {
                  const active = activeLocalTerms.has(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      className={`beike-chip ${active ? 'active' : ''}`}
                      onClick={() => toggleLocalTerm(tag)}
                    >
                      {tag} ({cnt})
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      <div className="feature-list">
        {houses.length === 0 ? (
          <div style={{ padding: 18, textAlign: 'center', color: '#64748b', fontSize: 12.5, lineHeight: 1.6 }}>
            <Home size={18} style={{ opacity: 0.5, marginBottom: 4 }} />
            <div>默认自动匹配当前视图所在城市</div>
            <div>点击「保存条件」可存为快捷方案一键填入</div>
          </div>
        ) : clusters.length === 0 ? (
          <div style={{ padding: 18, textAlign: 'center', color: '#64748b', fontSize: 12.5 }}>
            当前地图视口内无匹配房源，可取消「仅看视口内」或缩放地图。
          </div>
        ) : (
          <>
            {clusters.map((cluster) => (
              <div
                key={cluster.key}
                className={`feature-item ${cluster.key === activeClusterKey ? 'selected' : ''}`}
                onClick={() => onSelectCluster(cluster.key)}
              >
                <span className="beike-price-pill">
                  ¥{cluster.minPrice > 0 ? Math.round(cluster.minPrice) : '-'}
                </span>
                <div className="feature-meta">
                  <div className="feature-title">{cluster.resblock}</div>
                  <div className="feature-sub">
                    {[cluster.district, cluster.bizcircle].filter(Boolean).join(' · ')} · {cluster.houses.length} 套
                  </div>
                </div>
              </div>
            ))}

            {meta && (meta.next_page ?? 0) > 0 && (
              <button
                type="button"
                className="btn outline"
                style={{ justifyContent: 'center', marginTop: 6 }}
                disabled={loadingMore}
                onClick={() => void handleLoadMore()}
              >
                {loadingMore
                  ? '加载中...'
                  : `加载更多（第 ${meta.next_page} 页${meta.remaining_pages ? `，剩 ${meta.remaining_pages} 页` : ''}）`}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
