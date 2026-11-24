package service

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"little-map/pkg/geo"
)

const (
	maxBoundaryVertices   = 240
	amapPolygonMaxRadiusM = 100000.0
	amapAroundMinRadiusM  = 5000.0
	amapAroundMaxRadiusM  = 50000.0
	defaultAroundRadiusM  = 20000.0
)

// SearchOptions 描述地点搜索的空间偏好（全部为 WGS-84 坐标）。
type SearchOptions struct {
	CenterLng *float64    // 优先搜索中心经度（视图中心或当前位置）
	CenterLat *float64    // 优先搜索中心纬度
	Bounds    *[4]float64 // 视口包围盒 [minLng, minLat, maxLng, maxLat]
}

type normalizedSearchArea struct {
	hasCenter       bool
	centerLng       float64
	centerLat       float64
	hasBounds       bool
	bounds          [4]float64 // [minLng, minLat, maxLng, maxLat]
	viewportRadiusM float64
}

func isValidCoord(lng, lat float64) bool {
	if math.IsNaN(lng) || math.IsInf(lng, 0) || math.IsNaN(lat) || math.IsInf(lat, 0) {
		return false
	}
	return lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90
}

func normalizeSearchOptions(opts []SearchOptions) normalizedSearchArea {
	var area normalizedSearchArea
	if len(opts) == 0 {
		return area
	}
	opt := opts[0]

	if opt.Bounds != nil {
		b := *opt.Bounds
		if isValidCoord(b[0], b[1]) && isValidCoord(b[2], b[3]) && b[0] < b[2] && b[1] < b[3] {
			area.hasBounds = true
			area.bounds = b
			area.hasCenter = true
			area.centerLng = (b[0] + b[2]) / 2
			area.centerLat = (b[1] + b[3]) / 2
			area.viewportRadiusM = haversineRouteMeters(area.centerLng, area.centerLat, b[2], b[3])
		}
	}

	if opt.CenterLng != nil && opt.CenterLat != nil && isValidCoord(*opt.CenterLng, *opt.CenterLat) {
		area.hasCenter = true
		area.centerLng = *opt.CenterLng
		area.centerLat = *opt.CenterLat
	}
	return area
}

func (a normalizedSearchArea) pointInExpandedBounds(lng, lat, scale float64) bool {
	if !a.hasBounds {
		return false
	}
	halfW := (a.bounds[2] - a.bounds[0]) * 0.5 * scale
	halfH := (a.bounds[3] - a.bounds[1]) * 0.5 * scale
	cLng := (a.bounds[0] + a.bounds[2]) * 0.5
	cLat := (a.bounds[1] + a.bounds[3]) * 0.5
	return lng >= cLng-halfW && lng <= cLng+halfW && lat >= cLat-halfH && lat <= cLat+halfH
}

// PlaceResult 表示统一转换为 WGS-84 的地点搜索结果。
type PlaceResult struct {
	ID           string        `json:"id,omitempty"`
	Name         string        `json:"name"`
	Address      string        `json:"address"`
	Lng          float64       `json:"lng"`
	Lat          float64       `json:"lat"`
	Provider     string        `json:"provider"`
	Category     string        `json:"category,omitempty"`
	Boundary     *geo.Geometry `json:"boundary,omitempty"`
	Tel          string        `json:"tel,omitempty"`
	OpenTime     string        `json:"open_time,omitempty"`
	Rating       string        `json:"rating,omitempty"`
	Cost         string        `json:"cost,omitempty"`
	BusinessArea string        `json:"business_area,omitempty"`
	Tags         []string      `json:"tags,omitempty"`
	Photos       []string      `json:"photos,omitempty"`
	Alias        string        `json:"alias,omitempty"`
}

// SearchPlaces 搜索地点并统一返回 WGS-84 坐标；传入 SearchOptions 时优先搜索视图内或中心附近。
func (s *Service) SearchPlaces(ctx context.Context, query, provider string, limit int, opts ...SearchOptions) ([]PlaceResult, string, error) {
	q := strings.TrimSpace(query)
	if q == "" {
		return nil, "", fmt.Errorf("%w: query cannot be empty", ErrInvalidInput)
	}
	if limit <= 0 {
		limit = 20
	} else if limit > 25 {
		limit = 25
	}

	area := normalizeSearchOptions(opts)

	chosen := strings.ToLower(strings.TrimSpace(provider))
	if chosen == "" || chosen == "auto" {
		switch {
		case s.cfg.AmapKey != "":
			chosen = "amap"
		case s.cfg.GoogleMapsKey != "":
			chosen = "google"
		default:
			chosen = "osm"
		}
	}

	switch chosen {
	case "amap":
		if s.cfg.AmapKey == "" {
			return s.searchOSM(ctx, q, limit, area)
		}
		res, err := s.searchAmap(ctx, q, limit, area)
		if err != nil {
			return s.searchOSM(ctx, q, limit, area)
		}
		return res, "amap", nil

	case "google":
		if s.cfg.GoogleMapsKey == "" {
			return s.searchOSM(ctx, q, limit, area)
		}
		res, err := s.searchGoogle(ctx, q, limit, area)
		if err != nil {
			return s.searchOSM(ctx, q, limit, area)
		}
		return res, "google", nil

	case "osm":
		return s.searchOSM(ctx, q, limit, area)

	default:
		return nil, "", fmt.Errorf("%w: unknown provider %q", ErrInvalidInput, provider)
	}
}

type amapPhotoItem struct {
	Title string `json:"title"`
	URL   string `json:"url"`
}

type amapPOIItem struct {
	ID           string          `json:"id"`
	Name         string          `json:"name"`
	Address      any             `json:"address"`
	CityName     string          `json:"cityname"`
	AdName       string          `json:"adname"`
	Location     string          `json:"location"`
	Type         string          `json:"type"`
	Tel          any             `json:"tel"`
	BusinessArea any             `json:"business_area"`
	Photos       []amapPhotoItem `json:"photos"`
	Business     *struct {
		Tel           any `json:"tel"`
		OpenTimeToday any `json:"opentime_today"`
		OpenTimeWeek  any `json:"opentime_week"`
		Rating        any `json:"rating"`
		Cost          any `json:"cost"`
		Tag           any `json:"tag"`
		BusinessArea  any `json:"business_area"`
		Alias         any `json:"alias"`
	} `json:"business"`
	BizExt *struct {
		Rating   any `json:"rating"`
		Cost     any `json:"cost"`
		OpenTime any `json:"open_time"`
	} `json:"biz_ext"`
}

func asTrimmedString(v any) string {
	switch val := v.(type) {
	case string:
		return strings.TrimSpace(val)
	case float64:
		if val == 0 {
			return ""
		}
		return strconv.FormatFloat(val, 'f', -1, 64)
	default:
		return ""
	}
}

func splitPOITags(raw string) []string {
	if raw == "" {
		return nil
	}
	parts := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ';' || r == '，' || r == '、'
	})
	seen := make(map[string]struct{}, len(parts))
	out := make([]string, 0, min(6, len(parts)))
	for _, p := range parts {
		t := strings.TrimSpace(p)
		if t == "" {
			continue
		}
		if _, ok := seen[t]; ok {
			continue
		}
		seen[t] = struct{}{}
		out = append(out, t)
		if len(out) >= 6 {
			break
		}
	}
	return out
}

func extractPOIPhotos(items []amapPhotoItem) []string {
	if len(items) == 0 {
		return nil
	}
	out := make([]string, 0, min(4, len(items)))
	for _, p := range items {
		u := strings.TrimSpace(p.URL)
		if strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://") {
			out = append(out, u)
			if len(out) >= 4 {
				break
			}
		}
	}
	return out
}

func (s *Service) fetchAmapPOIs(ctx context.Context, endpoint string) ([]amapPOIItem, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("amap request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("amap status: %d", resp.StatusCode)
	}

	var payload struct {
		Status string        `json:"status"`
		Info   string        `json:"info"`
		POIs   []amapPOIItem `json:"pois"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode amap response: %w", err)
	}
	if payload.Status != "1" {
		return nil, fmt.Errorf("amap api error: %s", payload.Info)
	}
	return payload.POIs, nil
}

// buildBoundsPolygonGCJ02 将 WGS-84 视口矩形转换为高德 polygon 搜索参数（v5 用 '|' 分隔，v3 用 ';' 分隔）。
func buildBoundsPolygonGCJ02(b [4]float64, sep string) string {
	swLng, swLat := geo.WGS84ToGCJ02(b[0], b[1])
	seLng, seLat := geo.WGS84ToGCJ02(b[2], b[1])
	neLng, neLat := geo.WGS84ToGCJ02(b[2], b[3])
	nwLng, nwLat := geo.WGS84ToGCJ02(b[0], b[3])
	pts := []string{
		fmt.Sprintf("%.6f,%.6f", swLng, swLat),
		fmt.Sprintf("%.6f,%.6f", seLng, seLat),
		fmt.Sprintf("%.6f,%.6f", neLng, neLat),
		fmt.Sprintf("%.6f,%.6f", nwLng, nwLat),
		fmt.Sprintf("%.6f,%.6f", swLng, swLat),
	}
	return strings.Join(pts, sep)
}

// fetchAmapPOIsV5OrV3 优先请求高德 POI 2.0 (v5) 以获得更丰富的召回，失败时自动降级到 v3。
func (s *Service) fetchAmapPOIsV5OrV3(ctx context.Context, path string, v5Params, v3Params url.Values) ([]amapPOIItem, error) {
	v5Endpoint := "https://restapi.amap.com/v5/place/" + path + "?" + v5Params.Encode()
	if res, err := s.fetchAmapPOIs(ctx, v5Endpoint); err == nil {
		return res, nil
	}
	v3Endpoint := "https://restapi.amap.com/v3/place/" + path + "?" + v3Params.Encode()
	return s.fetchAmapPOIs(ctx, v3Endpoint)
}

func mergeAmapPOIs(existing, incoming []amapPOIItem, limit int) []amapPOIItem {
	seen := make(map[string]struct{}, len(existing)+len(incoming))
	out := make([]amapPOIItem, 0, min(limit, len(existing)+len(incoming)))
	add := func(item amapPOIItem) {
		if len(out) >= limit {
			return
		}
		key := strings.TrimSpace(item.ID)
		if key == "" {
			key = item.Name + "@" + item.Location
		}
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		out = append(out, item)
	}
	for _, p := range existing {
		add(p)
	}
	for _, p := range incoming {
		add(p)
	}
	return out
}

func hasRemoteDistrict(districts []PlaceResult, area normalizedSearchArea) bool {
	if len(districts) == 0 || (!area.hasBounds && !area.hasCenter) {
		return false
	}
	maxNearM := math.Max(area.viewportRadiusM*2, amapAroundMaxRadiusM)
	for _, d := range districts {
		if area.hasBounds && area.pointInExpandedBounds(d.Lng, d.Lat, 1.5) {
			return false
		}
		if area.hasCenter && haversineRouteMeters(area.centerLng, area.centerLat, d.Lng, d.Lat) <= maxNearM {
			return false
		}
	}
	return true
}

func (s *Service) searchAmap(ctx context.Context, query string, limit int, area normalizedSearchArea) ([]PlaceResult, error) {
	districtCh := make(chan []PlaceResult, 1)
	go func() {
		dCtx, cancel := context.WithTimeout(ctx, 2500*time.Millisecond)
		defer cancel()
		districtCh <- s.searchAmapDistrict(dCtx, query)
	}()

	var pois []amapPOIItem
	var lastErr error
	usedLocalSearch := false
	limitStr := strconv.Itoa(limit)

	// 1. 视图范围合理时优先在视口多边形内搜索
	if area.hasBounds && area.viewportRadiusM <= amapPolygonMaxRadiusM {
		v5Params := url.Values{
			"key":         {s.cfg.AmapKey},
			"keywords":    {query},
			"polygon":     {buildBoundsPolygonGCJ02(area.bounds, "|")},
			"show_fields": {"business,photos"},
			"page_size":   {limitStr},
			"page_num":    {"1"},
		}
		v3Params := url.Values{
			"key":        {s.cfg.AmapKey},
			"keywords":   {query},
			"polygon":    {buildBoundsPolygonGCJ02(area.bounds, ";")},
			"extensions": {"all"},
			"offset":     {limitStr},
			"page":       {"1"},
		}
		if res, err := s.fetchAmapPOIsV5OrV3(ctx, "polygon", v5Params, v3Params); err == nil {
			pois = mergeAmapPOIs(pois, res, limit)
			if len(pois) > 0 {
				usedLocalSearch = true
			}
		} else {
			lastErr = err
		}
	}

	// 2. 视口内结果不足 limit（或未传视口）时，用视图中心/当前位置附近周边搜索补足
	if len(pois) < limit && area.hasCenter {
		radius := defaultAroundRadiusM
		if area.hasBounds {
			radius = math.Max(amapAroundMinRadiusM, math.Min(amapAroundMaxRadiusM, area.viewportRadiusM*2))
		}
		gLng, gLat := geo.WGS84ToGCJ02(area.centerLng, area.centerLat)
		locStr := fmt.Sprintf("%.6f,%.6f", gLng, gLat)
		radiusStr := strconv.Itoa(int(math.Round(radius)))
		v5Params := url.Values{
			"key":         {s.cfg.AmapKey},
			"keywords":    {query},
			"location":    {locStr},
			"radius":      {radiusStr},
			"sortrule":    {"weight"},
			"show_fields": {"business,photos"},
			"page_size":   {limitStr},
			"page_num":    {"1"},
		}
		v3Params := url.Values{
			"key":        {s.cfg.AmapKey},
			"keywords":   {query},
			"location":   {locStr},
			"radius":     {radiusStr},
			"sortrule":   {"weight"},
			"extensions": {"all"},
			"offset":     {limitStr},
			"page":       {"1"},
		}
		if res, err := s.fetchAmapPOIsV5OrV3(ctx, "around", v5Params, v3Params); err == nil {
			pois = mergeAmapPOIs(pois, res, limit)
			if len(pois) > 0 {
				usedLocalSearch = true
			}
		} else {
			lastErr = err
		}
	}

	districts := <-districtCh

	// 若命中的是远离当前视图的行政区（如在北京搜"杭州"），改用全局文本搜索，避免混入本地无关店铺
	if usedLocalSearch && hasRemoteDistrict(districts, area) {
		pois = nil
	}

	// 3. 本地无结果或搜远方地名时回退全局文本搜索
	if len(pois) == 0 {
		v5Params := url.Values{
			"key":         {s.cfg.AmapKey},
			"keywords":    {query},
			"show_fields": {"business,photos"},
			"page_size":   {limitStr},
			"page_num":    {"1"},
		}
		v3Params := url.Values{
			"key":        {s.cfg.AmapKey},
			"keywords":   {query},
			"extensions": {"all"},
			"offset":     {limitStr},
			"page":       {"1"},
		}
		res, err := s.fetchAmapPOIsV5OrV3(ctx, "text", v5Params, v3Params)
		if err != nil {
			if len(districts) == 0 {
				if lastErr != nil {
					return nil, lastErr
				}
				return nil, err
			}
		} else {
			pois = res
		}
	}

	results := make([]PlaceResult, 0, len(districts)+len(pois))
	districtNames := make(map[string]struct{}, len(districts))
	for _, d := range districts {
		results = append(results, d)
		districtNames[d.Name] = struct{}{}
	}

	seenPOIs := make(map[string]struct{}, len(pois))
	for _, poi := range pois {
		if len(results) >= limit {
			break
		}
		parts := strings.Split(poi.Location, ",")
		if len(parts) != 2 {
			continue
		}
		gLng, err1 := strconv.ParseFloat(parts[0], 64)
		gLat, err2 := strconv.ParseFloat(parts[1], 64)
		if err1 != nil || err2 != nil {
			continue
		}
		// 高德返回 GCJ-02，统一转换为 WGS-84 供前后端使用。
		wLng, wLat := geo.GCJ02ToWGS84(gLng, gLat)

		if _, isDistrict := districtNames[poi.Name]; isDistrict {
			continue
		}
		dedupKey := strings.TrimSpace(poi.ID)
		if dedupKey == "" {
			dedupKey = fmt.Sprintf("%s@%.4f,%.4f", poi.Name, wLng, wLat)
		}
		if _, exists := seenPOIs[dedupKey]; exists {
			continue
		}
		seenPOIs[dedupKey] = struct{}{}

		addrStr := asTrimmedString(poi.Address)
		fullAddr := strings.TrimSpace(strings.Join([]string{poi.CityName, poi.AdName, addrStr}, " "))

		tel := asTrimmedString(poi.Tel)
		bizArea := asTrimmedString(poi.BusinessArea)
		var openTime, rating, cost, alias string
		var tags []string
		if poi.Business != nil {
			if t := asTrimmedString(poi.Business.Tel); t != "" {
				tel = t
			}
			if ba := asTrimmedString(poi.Business.BusinessArea); ba != "" {
				bizArea = ba
			}
			openTime = asTrimmedString(poi.Business.OpenTimeToday)
			if openTime == "" {
				openTime = asTrimmedString(poi.Business.OpenTimeWeek)
			}
			rating = asTrimmedString(poi.Business.Rating)
			cost = asTrimmedString(poi.Business.Cost)
			alias = asTrimmedString(poi.Business.Alias)
			tags = splitPOITags(asTrimmedString(poi.Business.Tag))
		}
		if poi.BizExt != nil {
			if rating == "" {
				rating = asTrimmedString(poi.BizExt.Rating)
			}
			if cost == "" {
				cost = asTrimmedString(poi.BizExt.Cost)
			}
			if openTime == "" {
				openTime = asTrimmedString(poi.BizExt.OpenTime)
			}
		}

		results = append(results, PlaceResult{
			ID:           strings.TrimSpace(poi.ID),
			Name:         poi.Name,
			Address:      fullAddr,
			Lng:          wLng,
			Lat:          wLat,
			Provider:     "amap",
			Category:     poi.Type,
			Tel:          tel,
			OpenTime:     openTime,
			Rating:       rating,
			Cost:         cost,
			BusinessArea: bizArea,
			Tags:         tags,
			Photos:       extractPOIPhotos(poi.Photos),
			Alias:        alias,
		})
	}
	return results, nil
}

func (s *Service) searchAmapDistrict(ctx context.Context, query string) []PlaceResult {
	endpoint := "https://restapi.amap.com/v3/config/district?" + url.Values{
		"key":         {s.cfg.AmapKey},
		"keywords":    {query},
		"subdistrict": {"0"},
		"extensions":  {"all"},
	}.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil
	}

	var payload struct {
		Status    string `json:"status"`
		Districts []struct {
			Name     string `json:"name"`
			Center   string `json:"center"`
			Level    string `json:"level"`
			Polyline string `json:"polyline"`
		} `json:"districts"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil || payload.Status != "1" {
		return nil
	}

	out := make([]PlaceResult, 0, min(2, len(payload.Districts)))
	for _, d := range payload.Districts {
		if len(out) >= 2 {
			break
		}
		boundary := parseAmapPolylineToPolygon(d.Polyline)
		if boundary == nil {
			continue
		}
		parts := strings.Split(d.Center, ",")
		if len(parts) != 2 {
			continue
		}
		gLng, err1 := strconv.ParseFloat(parts[0], 64)
		gLat, err2 := strconv.ParseFloat(parts[1], 64)
		if err1 != nil || err2 != nil {
			continue
		}
		wLng, wLat := geo.GCJ02ToWGS84(gLng, gLat)
		out = append(out, PlaceResult{
			Name:     d.Name,
			Address:  "行政区划边界 (" + d.Level + ")",
			Lng:      wLng,
			Lat:      wLat,
			Provider: "amap",
			Category: "行政区划",
			Boundary: boundary,
		})
	}
	return out
}

func (s *Service) searchGoogle(ctx context.Context, query string, limit int, area normalizedSearchArea) ([]PlaceResult, error) {
	params := url.Values{
		"key":   {s.cfg.GoogleMapsKey},
		"query": {query},
	}
	if area.hasCenter {
		radius := 10000.0
		if area.hasBounds {
			radius = math.Max(1000, math.Min(amapAroundMaxRadiusM, area.viewportRadiusM))
		}
		params.Set("location", fmt.Sprintf("%.6f,%.6f", area.centerLat, area.centerLng))
		params.Set("radius", strconv.Itoa(int(math.Round(radius))))
	}
	endpoint := "https://maps.googleapis.com/maps/api/place/textsearch/json?" + params.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("google request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("google status: %d", resp.StatusCode)
	}

	var payload struct {
		Status  string `json:"status"`
		Results []struct {
			Name             string `json:"name"`
			FormattedAddress string `json:"formatted_address"`
			Geometry         struct {
				Location struct {
					Lat float64 `json:"lat"`
					Lng float64 `json:"lng"`
				} `json:"location"`
			} `json:"geometry"`
		} `json:"results"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode google response: %w", err)
	}

	results := make([]PlaceResult, 0, min(limit, len(payload.Results)))
	for i, item := range payload.Results {
		if i >= limit {
			break
		}
		results = append(results, PlaceResult{
			Name:     item.Name,
			Address:  item.FormattedAddress,
			Lng:      item.Geometry.Location.Lng,
			Lat:      item.Geometry.Location.Lat,
			Provider: "google",
		})
	}
	return results, nil
}

func (s *Service) searchOSM(ctx context.Context, query string, limit int, area normalizedSearchArea) ([]PlaceResult, string, error) {
	params := url.Values{
		"q":               {query},
		"format":          {"jsonv2"},
		"limit":           {strconv.Itoa(limit)},
		"polygon_geojson": {"1"},
	}
	if area.hasBounds {
		// Nominatim viewbox 格式: left(minLng),top(maxLat),right(maxLng),bottom(minLat)
		params.Set("viewbox", fmt.Sprintf("%.6f,%.6f,%.6f,%.6f", area.bounds[0], area.bounds[3], area.bounds[2], area.bounds[1]))
	} else if area.hasCenter {
		const delta = 0.15
		minLng := math.Max(-180, area.centerLng-delta)
		maxLng := math.Min(180, area.centerLng+delta)
		minLat := math.Max(-90, area.centerLat-delta)
		maxLat := math.Min(90, area.centerLat+delta)
		params.Set("viewbox", fmt.Sprintf("%.6f,%.6f,%.6f,%.6f", minLng, maxLat, maxLng, minLat))
	}
	endpoint := "https://nominatim.openstreetmap.org/search?" + params.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, "osm", err
	}
	req.Header.Set("User-Agent", "little-map/1.0 (+https://github.com/little-map)")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, "osm", fmt.Errorf("osm request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, "osm", fmt.Errorf("osm status: %d", resp.StatusCode)
	}

	var items []struct {
		Name        string          `json:"name"`
		DisplayName string          `json:"display_name"`
		Lat         string          `json:"lat"`
		Lon         string          `json:"lon"`
		Category    string          `json:"category"`
		GeoJSON     json.RawMessage `json:"geojson"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&items); err != nil {
		return nil, "osm", fmt.Errorf("decode osm response: %w", err)
	}

	results := make([]PlaceResult, 0, len(items))
	for _, item := range items {
		lat, err1 := strconv.ParseFloat(item.Lat, 64)
		lng, err2 := strconv.ParseFloat(item.Lon, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		name := strings.TrimSpace(item.Name)
		if name == "" {
			name = strings.Split(item.DisplayName, ",")[0]
		}
		results = append(results, PlaceResult{
			Name:     name,
			Address:  item.DisplayName,
			Lng:      lng,
			Lat:      lat,
			Provider: "osm",
			Category: item.Category,
			Boundary: parseOSMGeoJSONToPolygon(item.GeoJSON),
		})
	}

	// 若同时存在视口附近和极远的结果，仅保留视口附近结果，避免自动缩放被远方噪声拉偏
	if area.hasBounds && len(results) > 1 {
		nearby := make([]PlaceResult, 0, len(results))
		for _, r := range results {
			if area.pointInExpandedBounds(r.Lng, r.Lat, 1.5) {
				nearby = append(nearby, r)
			}
		}
		if len(nearby) > 0 {
			results = nearby
		}
	}
	return results, "osm", nil
}

// parseAmapPolylineToPolygon 解析高德行政区 polyline（GCJ-02）为主多边形 WGS-84 Polygon。
func parseAmapPolylineToPolygon(polyline string) *geo.Geometry {
	if strings.TrimSpace(polyline) == "" {
		return nil
	}

	var bestRing [][]float64
	for _, block := range strings.Split(polyline, "|") {
		pts := strings.Split(block, ";")
		if len(pts) < 3 {
			continue
		}
		ring := make([][]float64, 0, len(pts)+1)
		for _, pt := range pts {
			xy := strings.Split(pt, ",")
			if len(xy) != 2 {
				continue
			}
			gLng, err1 := strconv.ParseFloat(strings.TrimSpace(xy[0]), 64)
			gLat, err2 := strconv.ParseFloat(strings.TrimSpace(xy[1]), 64)
			if err1 != nil || err2 != nil {
				continue
			}
			wLng, wLat := geo.GCJ02ToWGS84(gLng, gLat)
			ring = append(ring, []float64{roundCoord(wLng), roundCoord(wLat)})
		}
		if len(ring) > len(bestRing) {
			bestRing = ring
		}
	}
	return buildPolygonGeometry(bestRing)
}

// parseOSMGeoJSONToPolygon 从 OSM Nominatim 的 geojson 字段提取主多边形外环。
func parseOSMGeoJSONToPolygon(raw json.RawMessage) *geo.Geometry {
	if len(raw) == 0 {
		return nil
	}
	var head struct {
		Type        string          `json:"type"`
		Coordinates json.RawMessage `json:"coordinates"`
	}
	if err := json.Unmarshal(raw, &head); err != nil {
		return nil
	}

	var bestRing [][]float64
	switch head.Type {
	case "Polygon":
		var rings [][][]float64
		if err := json.Unmarshal(head.Coordinates, &rings); err == nil && len(rings) > 0 {
			bestRing = rings[0]
		}
	case "MultiPolygon":
		var polys [][][][]float64
		if err := json.Unmarshal(head.Coordinates, &polys); err == nil {
			for _, poly := range polys {
				if len(poly) > 0 && len(poly[0]) > len(bestRing) {
					bestRing = poly[0]
				}
			}
		}
	default:
		return nil
	}
	return buildPolygonGeometry(bestRing)
}

func buildPolygonGeometry(ring [][]float64) *geo.Geometry {
	simplified := simplifyClosedRing(ring, maxBoundaryVertices)
	if len(simplified) < 4 {
		return nil
	}
	raw, err := json.Marshal([][][]float64{simplified})
	if err != nil {
		return nil
	}
	geom := &geo.Geometry{
		Type:        "Polygon",
		Coordinates: raw,
	}
	if err := geo.ValidateGeometry(*geom); err != nil {
		return nil
	}
	return geom
}

// simplifyClosedRing 抽稀过密多边形顶点并确保首尾闭合，避免生成过大 GeoJSON。
func simplifyClosedRing(ring [][]float64, maxVertices int) [][]float64 {
	if len(ring) < 3 {
		return nil
	}

	open := ring
	first, last := ring[0], ring[len(ring)-1]
	if len(first) >= 2 && len(last) >= 2 && first[0] == last[0] && first[1] == last[1] {
		open = ring[:len(ring)-1]
	}
	if len(open) < 3 {
		return nil
	}

	out := make([][]float64, 0, min(len(open), maxVertices)+1)
	if len(open) <= maxVertices {
		for _, p := range open {
			if len(p) >= 2 {
				out = append(out, []float64{roundCoord(p[0]), roundCoord(p[1])})
			}
		}
	} else {
		step := float64(len(open)) / float64(maxVertices)
		for i := range maxVertices {
			idx := int(math.Floor(float64(i) * step))
			if idx >= len(open) {
				idx = len(open) - 1
			}
			p := open[idx]
			if len(p) >= 2 {
				out = append(out, []float64{roundCoord(p[0]), roundCoord(p[1])})
			}
		}
	}
	if len(out) < 3 {
		return nil
	}
	out = append(out, []float64{out[0][0], out[0][1]})
	return out
}

func roundCoord(v float64) float64 {
	return math.Round(v*1e6) / 1e6
}

// ReverseGeocode 使用高德 Web 服务对 WGS-84 坐标执行逆地理编码；未配置高德 Key 时返回 nil。
func (s *Service) ReverseGeocode(ctx context.Context, lng, lat float64) (*PlaceResult, error) {
	if s.cfg.AmapKey == "" {
		return nil, nil
	}
	if lng < -180 || lng > 180 || lat < -90 || lat > 90 {
		return nil, fmt.Errorf("%w: coordinate out of range", ErrInvalidInput)
	}

	// 高德逆地理编码接口要求 GCJ-02 坐标
	gLng, gLat := geo.WGS84ToGCJ02(lng, lat)
	endpoint := "https://restapi.amap.com/v3/geocode/regeo?" + url.Values{
		"key":        {s.cfg.AmapKey},
		"location":   {fmt.Sprintf("%.6f,%.6f", gLng, gLat)},
		"extensions": {"all"},
		"radius":     {"200"},
	}.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("amap regeo request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("amap regeo status: %d", resp.StatusCode)
	}

	var payload struct {
		Status    string `json:"status"`
		Info      string `json:"info"`
		Regeocode struct {
			FormattedAddress any `json:"formatted_address"`
			POIs             []struct {
				Name string `json:"name"`
				Type string `json:"type"`
			} `json:"pois"`
			AOIs []struct {
				Name string `json:"name"`
			} `json:"aois"`
		} `json:"regeocode"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode amap regeo response: %w", err)
	}
	if payload.Status != "1" {
		return nil, fmt.Errorf("amap regeo error: %s", payload.Info)
	}

	addr, _ := payload.Regeocode.FormattedAddress.(string)
	addr = strings.TrimSpace(addr)

	name := ""
	category := ""
	if len(payload.Regeocode.POIs) > 0 && strings.TrimSpace(payload.Regeocode.POIs[0].Name) != "" {
		name = strings.TrimSpace(payload.Regeocode.POIs[0].Name)
		category = payload.Regeocode.POIs[0].Type
	} else if len(payload.Regeocode.AOIs) > 0 && strings.TrimSpace(payload.Regeocode.AOIs[0].Name) != "" {
		name = strings.TrimSpace(payload.Regeocode.AOIs[0].Name)
	} else {
		name = addr
	}

	if name == "" {
		return nil, nil
	}
	return &PlaceResult{
		Name:     name,
		Address:  addr,
		Lng:      lng,
		Lat:      lat,
		Provider: "amap",
		Category: category,
	}, nil
}
