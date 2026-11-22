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

	"little-map/pkg/geo"
)

const (
	maxRouteWaypoints = 15
	maxRouteVertices  = 800
)

// RouteInput 定义骑行/徒步路径规划请求参数（统一使用 WGS-84 坐标）。
type RouteInput struct {
	Mode      string      `json:"mode"`
	Waypoints [][]float64 `json:"waypoints"`
	Provider  string      `json:"provider,omitempty"`
}

// RouteResult 表示统一转换为 WGS-84 的路径规划结果。
type RouteResult struct {
	Mode            string       `json:"mode"`
	Provider        string       `json:"provider"`
	DistanceMeters  float64      `json:"distance_meters"`
	DurationSeconds float64      `json:"duration_seconds"`
	Geometry        geo.Geometry `json:"geometry"`
}

// PlanRoute 规划骑行或徒步路线，国内有高德 Key 时优先高德，否则降级至免 Key 的 OSRM。
func (s *Service) PlanRoute(ctx context.Context, in RouteInput) (*RouteResult, error) {
	mode := strings.ToLower(strings.TrimSpace(in.Mode))
	if mode == "" {
		mode = "bicycling"
	}
	if mode != "bicycling" && mode != "walking" {
		return nil, fmt.Errorf("%w: unsupported mode %q (supported: bicycling, walking)", ErrInvalidInput, mode)
	}
	if len(in.Waypoints) < 2 {
		return nil, fmt.Errorf("%w: at least 2 waypoints are required", ErrInvalidInput)
	}
	if len(in.Waypoints) > maxRouteWaypoints {
		return nil, fmt.Errorf("%w: at most %d waypoints are allowed", ErrInvalidInput, maxRouteWaypoints)
	}
	for i, wp := range in.Waypoints {
		if len(wp) < 2 || wp[0] < -180 || wp[0] > 180 || wp[1] < -90 || wp[1] > 90 {
			return nil, fmt.Errorf("%w: invalid waypoint[%d]", ErrInvalidInput, i)
		}
	}

	provider := strings.ToLower(strings.TrimSpace(in.Provider))
	if provider == "" || provider == "auto" {
		if s.cfg.AmapKey != "" && isLikelyInChina(in.Waypoints[0][0], in.Waypoints[0][1]) {
			provider = "amap"
		} else {
			provider = "osrm"
		}
	}

	switch provider {
	case "amap":
		if s.cfg.AmapKey == "" {
			return s.planRouteOSRM(ctx, mode, in.Waypoints)
		}
		res, err := s.planRouteAmap(ctx, mode, in.Waypoints)
		if err != nil {
			return s.planRouteOSRM(ctx, mode, in.Waypoints)
		}
		return res, nil

	case "osrm":
		return s.planRouteOSRM(ctx, mode, in.Waypoints)

	default:
		return nil, fmt.Errorf("%w: unknown route provider %q", ErrInvalidInput, provider)
	}
}

func (s *Service) planRouteAmap(ctx context.Context, mode string, waypoints [][]float64) (*RouteResult, error) {
	var totalDist float64
	var totalDur float64
	merged := make([][]float64, 0, 128)

	for i := 0; i < len(waypoints)-1; i++ {
		oLng, oLat := geo.WGS84ToGCJ02(waypoints[i][0], waypoints[i][1])
		dLng, dLat := geo.WGS84ToGCJ02(waypoints[i+1][0], waypoints[i+1][1])
		origin := fmt.Sprintf("%.6f,%.6f", oLng, oLat)
		dest := fmt.Sprintf("%.6f,%.6f", dLng, dLat)

		var segDist, segDur float64
		var polylines []string
		var err error
		if mode == "walking" {
			segDist, segDur, polylines, err = s.fetchAmapWalkingSegment(ctx, origin, dest)
		} else {
			segDist, segDur, polylines, err = s.fetchAmapBicyclingSegment(ctx, origin, dest)
		}
		if err != nil {
			return nil, err
		}

		totalDist += segDist
		totalDur += segDur
		for _, pl := range polylines {
			merged = appendAmapPolylineWGS84(merged, pl)
		}
	}

	coords := simplifyLineCoords(merged, maxRouteVertices)
	if len(coords) < 2 {
		return nil, fmt.Errorf("amap route returned insufficient coordinates")
	}
	raw, err := json.Marshal(coords)
	if err != nil {
		return nil, fmt.Errorf("marshal route coords: %w", err)
	}

	return &RouteResult{
		Mode:            mode,
		Provider:        "amap",
		DistanceMeters:  totalDist,
		DurationSeconds: totalDur,
		Geometry: geo.Geometry{
			Type:        "LineString",
			Coordinates: raw,
		},
	}, nil
}

func (s *Service) fetchAmapWalkingSegment(ctx context.Context, origin, dest string) (float64, float64, []string, error) {
	endpoint := "https://restapi.amap.com/v3/direction/walking?" + url.Values{
		"key":         {s.cfg.AmapKey},
		"origin":      {origin},
		"destination": {dest},
	}.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return 0, 0, nil, err
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return 0, 0, nil, fmt.Errorf("amap walking request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return 0, 0, nil, fmt.Errorf("amap walking status: %d", resp.StatusCode)
	}

	var payload struct {
		Status string `json:"status"`
		Info   string `json:"info"`
		Route  struct {
			Paths []struct {
				Distance string `json:"distance"`
				Duration string `json:"duration"`
				Steps    []struct {
					Polyline string `json:"polyline"`
				} `json:"steps"`
			} `json:"paths"`
		} `json:"route"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return 0, 0, nil, fmt.Errorf("decode amap walking: %w", err)
	}
	if payload.Status != "1" || len(payload.Route.Paths) == 0 {
		return 0, 0, nil, fmt.Errorf("amap walking error: %s", payload.Info)
	}

	path := payload.Route.Paths[0]
	dist, _ := strconv.ParseFloat(path.Distance, 64)
	dur, _ := strconv.ParseFloat(path.Duration, 64)
	polylines := make([]string, 0, len(path.Steps))
	for _, st := range path.Steps {
		if st.Polyline != "" {
			polylines = append(polylines, st.Polyline)
		}
	}
	return dist, dur, polylines, nil
}

func (s *Service) fetchAmapBicyclingSegment(ctx context.Context, origin, dest string) (float64, float64, []string, error) {
	endpoint := "https://restapi.amap.com/v4/direction/bicycling?" + url.Values{
		"key":         {s.cfg.AmapKey},
		"origin":      {origin},
		"destination": {dest},
	}.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return 0, 0, nil, err
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return 0, 0, nil, fmt.Errorf("amap bicycling request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return 0, 0, nil, fmt.Errorf("amap bicycling status: %d", resp.StatusCode)
	}

	var payload struct {
		ErrCode int    `json:"errcode"`
		ErrMsg  string `json:"errmsg"`
		Data    struct {
			Paths []struct {
				Distance float64 `json:"distance"`
				Duration float64 `json:"duration"`
				Steps    []struct {
					Polyline string `json:"polyline"`
				} `json:"steps"`
			} `json:"paths"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return 0, 0, nil, fmt.Errorf("decode amap bicycling: %w", err)
	}
	if payload.ErrCode != 0 || len(payload.Data.Paths) == 0 {
		return 0, 0, nil, fmt.Errorf("amap bicycling error: %s", payload.ErrMsg)
	}

	path := payload.Data.Paths[0]
	polylines := make([]string, 0, len(path.Steps))
	for _, st := range path.Steps {
		if st.Polyline != "" {
			polylines = append(polylines, st.Polyline)
		}
	}
	return path.Distance, path.Duration, polylines, nil
}

func (s *Service) planRouteOSRM(ctx context.Context, mode string, waypoints [][]float64) (*RouteResult, error) {
	profile := "bike"
	if mode == "walking" {
		profile = "foot"
	}

	parts := make([]string, 0, len(waypoints))
	for _, wp := range waypoints {
		parts = append(parts, fmt.Sprintf("%.6f,%.6f", wp[0], wp[1]))
	}

	endpoint := fmt.Sprintf(
		"https://router.project-osrm.org/route/v1/%s/%s?overview=full&geometries=geojson",
		profile,
		strings.Join(parts, ";"),
	)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "little-map/1.0 (+https://github.com/little-map)")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("osrm route request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("osrm route status: %d", resp.StatusCode)
	}

	var payload struct {
		Code   string `json:"code"`
		Routes []struct {
			Distance float64 `json:"distance"`
			Duration float64 `json:"duration"`
			Geometry struct {
				Type        string      `json:"type"`
				Coordinates [][]float64 `json:"coordinates"`
			} `json:"geometry"`
		} `json:"routes"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode osrm route: %w", err)
	}
	if payload.Code != "Ok" || len(payload.Routes) == 0 {
		return nil, fmt.Errorf("osrm route failed: %s", payload.Code)
	}

	r := payload.Routes[0]
	coords := simplifyLineCoords(r.Geometry.Coordinates, maxRouteVertices)
	if len(coords) < 2 {
		return nil, fmt.Errorf("osrm route returned insufficient coordinates")
	}
	raw, err := json.Marshal(coords)
	if err != nil {
		return nil, fmt.Errorf("marshal osrm coords: %w", err)
	}

	return &RouteResult{
		Mode:            mode,
		Provider:        "osrm",
		DistanceMeters:  r.Distance,
		DurationSeconds: r.Duration,
		Geometry: geo.Geometry{
			Type:        "LineString",
			Coordinates: raw,
		},
	}, nil
}

func appendAmapPolylineWGS84(dst [][]float64, polyline string) [][]float64 {
	for _, pt := range strings.Split(polyline, ";") {
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
		rLng, rLat := roundCoord(wLng), roundCoord(wLat)
		if len(dst) > 0 {
			last := dst[len(dst)-1]
			if last[0] == rLng && last[1] == rLat {
				continue
			}
		}
		dst = append(dst, []float64{rLng, rLat})
	}
	return dst
}

func simplifyLineCoords(coords [][]float64, maxVertices int) [][]float64 {
	if len(coords) <= maxVertices || maxVertices < 2 {
		out := make([][]float64, 0, len(coords))
		for _, p := range coords {
			if len(p) >= 2 {
				out = append(out, []float64{roundCoord(p[0]), roundCoord(p[1])})
			}
		}
		return out
	}

	out := make([][]float64, 0, maxVertices)
	step := float64(len(coords)-1) / float64(maxVertices-1)
	for i := range maxVertices - 1 {
		idx := int(math.Round(float64(i) * step))
		p := coords[idx]
		out = append(out, []float64{roundCoord(p[0]), roundCoord(p[1])})
	}
	last := coords[len(coords)-1]
	out = append(out, []float64{roundCoord(last[0]), roundCoord(last[1])})
	return out
}

func isLikelyInChina(lng, lat float64) bool {
	return lng >= 72.004 && lng <= 137.8347 && lat >= 0.8293 && lat <= 55.8271
}
