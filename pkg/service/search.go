package service

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"little-map/pkg/geo"
)

// PlaceResult 表示统一转换为 WGS-84 的地点搜索结果。
type PlaceResult struct {
	Name     string  `json:"name"`
	Address  string  `json:"address"`
	Lng      float64 `json:"lng"`
	Lat      float64 `json:"lat"`
	Provider string  `json:"provider"`
	Category string  `json:"category,omitempty"`
}

// SearchPlaces 搜索地点并统一返回 WGS-84 坐标。
func (s *Service) SearchPlaces(ctx context.Context, query, provider string, limit int) ([]PlaceResult, string, error) {
	q := strings.TrimSpace(query)
	if q == "" {
		return nil, "", fmt.Errorf("%w: query cannot be empty", ErrInvalidInput)
	}
	if limit <= 0 || limit > 20 {
		limit = 8
	}

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
			return s.searchOSM(ctx, q, limit)
		}
		res, err := s.searchAmap(ctx, q, limit)
		if err != nil {
			return s.searchOSM(ctx, q, limit)
		}
		return res, "amap", nil

	case "google":
		if s.cfg.GoogleMapsKey == "" {
			return s.searchOSM(ctx, q, limit)
		}
		res, err := s.searchGoogle(ctx, q, limit)
		if err != nil {
			return s.searchOSM(ctx, q, limit)
		}
		return res, "google", nil

	case "osm":
		return s.searchOSM(ctx, q, limit)

	default:
		return nil, "", fmt.Errorf("%w: unknown provider %q", ErrInvalidInput, provider)
	}
}

func (s *Service) searchAmap(ctx context.Context, query string, limit int) ([]PlaceResult, error) {
	endpoint := "https://restapi.amap.com/v3/place/text?" + url.Values{
		"key":      {s.cfg.AmapKey},
		"keywords": {query},
		"offset":   {strconv.Itoa(limit)},
		"page":     {"1"},
	}.Encode()

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
		Status string `json:"status"`
		Info   string `json:"info"`
		POIs   []struct {
			Name     string `json:"name"`
			Address  any    `json:"address"`
			CityName string `json:"cityname"`
			AdName   string `json:"adname"`
			Location string `json:"location"`
			Type     string `json:"type"`
		} `json:"pois"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode amap response: %w", err)
	}
	if payload.Status != "1" {
		return nil, fmt.Errorf("amap api error: %s", payload.Info)
	}

	results := make([]PlaceResult, 0, len(payload.POIs))
	for _, poi := range payload.POIs {
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

		addrStr, _ := poi.Address.(string)
		fullAddr := strings.TrimSpace(strings.Join([]string{poi.CityName, poi.AdName, addrStr}, " "))
		results = append(results, PlaceResult{
			Name:     poi.Name,
			Address:  fullAddr,
			Lng:      wLng,
			Lat:      wLat,
			Provider: "amap",
			Category: poi.Type,
		})
	}
	return results, nil
}

func (s *Service) searchGoogle(ctx context.Context, query string, limit int) ([]PlaceResult, error) {
	endpoint := "https://maps.googleapis.com/maps/api/place/textsearch/json?" + url.Values{
		"key":   {s.cfg.GoogleMapsKey},
		"query": {query},
	}.Encode()

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

func (s *Service) searchOSM(ctx context.Context, query string, limit int) ([]PlaceResult, string, error) {
	endpoint := "https://nominatim.openstreetmap.org/search?" + url.Values{
		"q":      {query},
		"format": {"jsonv2"},
		"limit":  {strconv.Itoa(limit)},
	}.Encode()

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
		Name        string `json:"name"`
		DisplayName string `json:"display_name"`
		Lat         string `json:"lat"`
		Lon         string `json:"lon"`
		Category    string `json:"category"`
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
		})
	}
	return results, "osm", nil
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
