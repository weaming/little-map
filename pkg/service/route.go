package service

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"little-map/pkg/geo"
)

const (
	maxRouteWaypoints = 18
	maxRouteVertices  = 800
	amapMaxWaypoints  = 16
	amapRequestGap    = 360 * time.Millisecond
)

// RouteInput 定义驾车/骑行/徒步路径规划请求参数（统一使用 WGS-84 坐标）。
type RouteInput struct {
	Mode          string        `json:"mode"`
	Waypoints     [][]float64   `json:"waypoints"`
	SegmentModes  []string      `json:"segment_modes,omitempty"`
	AvoidPoints   [][]float64   `json:"avoid_points,omitempty"`
	AvoidSegments [][][]float64 `json:"avoid_segments,omitempty"`
	Provider      string        `json:"provider,omitempty"`
}

// RouteLeg 表示合并连续同策略路段后的单次接力导航任务。
type RouteLeg struct {
	Index           int         `json:"index"`
	Strategy        string      `json:"strategy"`
	From            []float64   `json:"from"`
	To              []float64   `json:"to"`
	Via             [][]float64 `json:"via,omitempty"`
	DistanceMeters  float64     `json:"distance_meters"`
	DurationSeconds float64     `json:"duration_seconds"`
	AmapNavURL      string      `json:"amap_nav_url"`
}

// TrafficSegment 表示驾车路线上的单个实时路况着色段（WGS-84）。
type TrafficSegment struct {
	Status      string      `json:"status"`
	Color       string      `json:"color"`
	Coordinates [][]float64 `json:"coordinates"`
}

// RouteResult 表示统一转换为 WGS-84 的路径规划结果。
type RouteResult struct {
	Mode            string           `json:"mode"`
	Provider        string           `json:"provider"`
	DistanceMeters  float64          `json:"distance_meters"`
	DurationSeconds float64          `json:"duration_seconds"`
	Geometry        geo.Geometry     `json:"geometry"`
	Legs            []RouteLeg       `json:"legs,omitempty"`
	TrafficSegments []TrafficSegment `json:"traffic_segments,omitempty"`
}

// PlanRoute 规划骑行或徒步路线，国内有高德 Key 时优先高德，否则降级至免 Key 的 OSRM。
func (s *Service) PlanRoute(ctx context.Context, in RouteInput) (*RouteResult, error) {
	mode := strings.ToLower(strings.TrimSpace(in.Mode))
	if mode == "" {
		mode = "bicycling"
	}
	if mode != "bicycling" && mode != "walking" && mode != "driving" {
		return nil, fmt.Errorf("%w: unsupported mode %q (supported: driving, bicycling, walking)", ErrInvalidInput, mode)
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
			return s.planRouteSegmented(ctx, mode, "osrm", in.Waypoints, in.SegmentModes, in.AvoidPoints, in.AvoidSegments)
		}
		res, err := s.planRouteSegmented(ctx, mode, "amap", in.Waypoints, in.SegmentModes, in.AvoidPoints, in.AvoidSegments)
		if err != nil {
			slog.Warn("amap route failed, falling back to osrm", "mode", mode, "waypoints", len(in.Waypoints), "err", err)
			return s.planRouteSegmented(ctx, mode, "osrm", in.Waypoints, in.SegmentModes, in.AvoidPoints, in.AvoidSegments)
		}
		return res, nil

	case "osrm":
		return s.planRouteSegmented(ctx, mode, "osrm", in.Waypoints, in.SegmentModes, in.AvoidPoints, in.AvoidSegments)

	default:
		return nil, fmt.Errorf("%w: unknown route provider %q", ErrInvalidInput, provider)
	}
}

func normalizeSegStrategy(mode string, segModes []string, idx int) string {
	if idx >= len(segModes) {
		return "auto"
	}
	raw := strings.ToLower(strings.TrimSpace(segModes[idx]))
	switch raw {
	case "direct":
		return "direct"
	case "highway", "national", "avoid-jam":
		if mode == "driving" {
			return raw
		}
		return "auto"
	default:
		return "auto"
	}
}

func amapDrivingStrategyCode(segStrategy string) string {
	switch segStrategy {
	case "highway":
		return "19" // 高速优先
	case "national":
		return "6" // 不走高速（国道/省道优先）
	case "avoid-jam":
		return "4" // 躲避拥堵
	default:
		return "0" // 速度优先
	}
}

// buildAmapAvoidPolygons 将 WGS-84 避开点与整段避开折线转换为高德 avoidpolygons（GCJ-02 窄旋转矩形带，不误封旁边并行国道）。
func buildAmapAvoidPolygons(avoidPoints [][]float64, avoidSegments [][][]float64) string {
	const (
		maxPolys   = 32
		dLng       = 0.0008 // 单点约 ±75m
		dLat       = 0.0007 // 单点约 ±75m
		halfWidthM = 55.0   // 沿路禁行带半宽约 55m（只封当前道路，放行旁边并行国道）
		chunkLenM  = 1800.0 // 每 ~1.8km 切一小块旋转矩形，贴合弯道且远低于高德 81km² 上限
	)
	polys := make([]string, 0, min(len(avoidPoints)+len(avoidSegments)*2, maxPolys))

	for _, pt := range avoidPoints {
		if len(polys) >= maxPolys {
			break
		}
		if len(pt) < 2 {
			continue
		}
		gLng, gLat := geo.WGS84ToGCJ02(pt[0], pt[1])
		polys = append(polys, fmt.Sprintf(
			"%.6f,%.6f;%.6f,%.6f;%.6f,%.6f;%.6f,%.6f",
			gLng-dLng, gLat-dLat,
			gLng+dLng, gLat-dLat,
			gLng+dLng, gLat+dLat,
			gLng-dLng, gLat+dLat,
		))
	}

	for _, seg := range avoidSegments {
		if len(polys) >= maxPolys || len(seg) < 2 {
			break
		}
		// 按累计长度切分为若干小段，每小段生成一个紧贴道路方向的旋转矩形
		chunkStart := seg[0]
		acc := 0.0
		emitBox := func(a, b []float64) {
			if len(polys) >= maxPolys || len(a) < 2 || len(b) < 2 {
				return
			}
			box := orientedCorridorGCJ02(a, b, halfWidthM)
			if box != "" {
				polys = append(polys, box)
			}
		}

		for i := 1; i < len(seg); i++ {
			acc += haversineRouteMeters(seg[i-1][0], seg[i-1][1], seg[i][0], seg[i][1])
			if acc >= chunkLenM || i == len(seg)-1 {
				emitBox(chunkStart, seg[i])
				chunkStart = seg[i]
				acc = 0
			}
		}
	}
	return strings.Join(polys, "|")
}

// orientedCorridorGCJ02 生成沿 WGS-84 线段 a->b 方向的窄旋转矩形（GCJ-02）。
func orientedCorridorGCJ02(a, b []float64, halfWidthMeters float64) string {
	ax, ay := geo.WGS84ToGCJ02(a[0], a[1])
	bx, by := geo.WGS84ToGCJ02(b[0], b[1])
	midLatRad := ((ay + by) / 2) * math.Pi / 180
	cosLat := math.Max(0.2, math.Cos(midLatRad))

	// 换算到近似平面米坐标求法向量
	dxM := (bx - ax) * 111320 * cosLat
	dyM := (by - ay) * 110540
	segLen := math.Hypot(dxM, dyM)
	if segLen < 1 {
		return ""
	}
	nxM := (-dyM / segLen) * halfWidthMeters
	nyM := (dxM / segLen) * halfWidthMeters

	nLng := nxM / (111320 * cosLat)
	nLat := nyM / 110540

	return fmt.Sprintf(
		"%.6f,%.6f;%.6f,%.6f;%.6f,%.6f;%.6f,%.6f",
		ax+nLng, ay+nLat,
		bx+nLng, by+nLat,
		bx-nLng, by-nLat,
		ax-nLng, ay-nLat,
	)
}

// planRouteSegmented 支持按段混用贴路策略（默认/高速/国道/避堵）与自由直线（direct），并输出拆分的接力导航段。
func (s *Service) planRouteSegmented(ctx context.Context, mode, provider string, waypoints [][]float64, segModes []string, avoidPoints [][]float64, avoidSegments [][][]float64) (*RouteResult, error) {
	segCount := len(waypoints) - 1
	hasDirect := false
	strategies := make([]string, segCount)
	for i := range segCount {
		strategies[i] = normalizeSegStrategy(mode, segModes, i)
		if strategies[i] == "direct" {
			hasDirect = true
		}
	}

	// 纯 OSRM 且无直线段时，单次请求完成以减少延迟
	if provider == "osrm" && !hasDirect {
		res, err := s.planRouteOSRM(ctx, mode, waypoints)
		if err != nil {
			return nil, err
		}
		res.Legs = buildRouteLegs(mode, waypoints, strategies, []float64{res.DistanceMeters}, []float64{res.DurationSeconds}, true)
		return res, nil
	}

	avoidPolygons := ""
	if mode == "driving" && provider == "amap" {
		avoidPolygons = buildAmapAvoidPolygons(avoidPoints, avoidSegments)
	}

	var totalDist float64
	var totalDur float64
	segDists := make([]float64, segCount)
	segDurs := make([]float64, segCount)
	merged := make([][]float64, 0, 128)
	var trafficSegs []TrafficSegment
	usedProvider := provider
	amapCalls := 0

	waitAmapQuota := func() error {
		if amapCalls > 0 {
			timer := time.NewTimer(amapRequestGap)
			defer timer.Stop()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-timer.C:
			}
		}
		amapCalls++
		return nil
	}

	for i := 0; i < segCount; i++ {
		p1 := waypoints[i]
		p2 := waypoints[i+1]
		strat := strategies[i]

		if strat == "direct" {
			dist := haversineRouteMeters(p1[0], p1[1], p2[0], p2[1])
			speed := 4.17 // 骑行约 15 km/h
			switch mode {
			case "walking":
				speed = 1.25 // 徒步约 4.5 km/h
			case "driving":
				speed = 16.67 // 驾车约 60 km/h
			}
			dur := dist / speed
			segDists[i] = dist
			segDurs[i] = dur
			totalDist += dist
			totalDur += dur
			merged = appendCoordDedup(merged, roundCoord(p1[0]), roundCoord(p1[1]))
			merged = appendCoordDedup(merged, roundCoord(p2[0]), roundCoord(p2[1]))
			continue
		}

		if provider == "amap" {
			if err := waitAmapQuota(); err != nil {
				return nil, err
			}

			// 高德驾车原生支持最多 16 个途经点：合并连续同策略路段为 1 次 HTTP 请求，大幅降低 QPS 消耗。
			if mode == "driving" {
				endSeg := i
				for endSeg+1 < segCount && strategies[endSeg+1] == strat && (endSeg-i) < amapMaxWaypoints {
					endSeg++
				}

				oLng, oLat := geo.WGS84ToGCJ02(waypoints[i][0], waypoints[i][1])
				dLng, dLat := geo.WGS84ToGCJ02(waypoints[endSeg+1][0], waypoints[endSeg+1][1])
				origin := fmt.Sprintf("%.6f,%.6f", oLng, oLat)
				dest := fmt.Sprintf("%.6f,%.6f", dLng, dLat)

				var viaParts []string
				for v := i + 1; v <= endSeg; v++ {
					vLng, vLat := geo.WGS84ToGCJ02(waypoints[v][0], waypoints[v][1])
					viaParts = append(viaParts, fmt.Sprintf("%.6f,%.6f", vLng, vLat))
				}

				segDist, segDur, polylines, tmcs, err := s.fetchAmapV3DirectionSegment(
					ctx,
					"driving",
					origin,
					dest,
					strings.Join(viaParts, ";"),
					amapDrivingStrategyCode(strat),
					avoidPolygons,
				)
				if err != nil {
					return nil, err
				}

				segDists[i] = segDist
				segDurs[i] = segDur
				totalDist += segDist
				totalDur += segDur
				for _, pl := range polylines {
					merged = appendAmapPolylineWGS84(merged, pl)
				}
				if len(tmcs) > 0 {
					trafficSegs = appendTrafficSegments(trafficSegs, tmcs)
				} else {
					slog.Info("amap driving segment returned no tmcs", "seg", i, "origin", origin, "dest", dest)
				}
				i = endSeg
				continue
			}

			oLng, oLat := geo.WGS84ToGCJ02(p1[0], p1[1])
			dLng, dLat := geo.WGS84ToGCJ02(p2[0], p2[1])
			origin := fmt.Sprintf("%.6f,%.6f", oLng, oLat)
			dest := fmt.Sprintf("%.6f,%.6f", dLng, dLat)

			var segDist, segDur float64
			var polylines []string
			var err error
			if mode == "walking" {
				segDist, segDur, polylines, _, err = s.fetchAmapV3DirectionSegment(ctx, "walking", origin, dest, "", "", "")
			} else {
				segDist, segDur, polylines, err = s.fetchAmapBicyclingSegment(ctx, origin, dest)
			}
			if err != nil {
				return nil, err
			}
			segDists[i] = segDist
			segDurs[i] = segDur
			totalDist += segDist
			totalDur += segDur
			for _, pl := range polylines {
				merged = appendAmapPolylineWGS84(merged, pl)
			}
		} else {
			segRes, err := s.planRouteOSRM(ctx, mode, [][]float64{p1, p2})
			if err != nil {
				return nil, err
			}
			segDists[i] = segRes.DistanceMeters
			segDurs[i] = segRes.DurationSeconds
			totalDist += segRes.DistanceMeters
			totalDur += segRes.DurationSeconds
			var segCoords [][]float64
			if err := json.Unmarshal(segRes.Geometry.Coordinates, &segCoords); err == nil {
				for _, pt := range segCoords {
					if len(pt) >= 2 {
						merged = appendCoordDedup(merged, roundCoord(pt[0]), roundCoord(pt[1]))
					}
				}
			}
		}
	}

	coords := simplifyLineCoords(merged, maxRouteVertices)
	if len(coords) < 2 {
		return nil, fmt.Errorf("route returned insufficient coordinates")
	}
	raw, err := json.Marshal(coords)
	if err != nil {
		return nil, fmt.Errorf("marshal route coords: %w", err)
	}
	if hasDirect {
		usedProvider = provider + "+direct"
	}

	return &RouteResult{
		Mode:            mode,
		Provider:        usedProvider,
		DistanceMeters:  totalDist,
		DurationSeconds: totalDur,
		Geometry: geo.Geometry{
			Type:        "LineString",
			Coordinates: raw,
		},
		Legs:            buildRouteLegs(mode, waypoints, strategies, segDists, segDurs, false),
		TrafficSegments: trafficSegs,
	}, nil
}

// buildRouteLegs 合并相邻相同策略的路段，拆分为最少次数的独立高德接力导航任务。
func buildRouteLegs(mode string, waypoints [][]float64, strategies []string, segDists, segDurs []float64, singleAggregated bool) []RouteLeg {
	if len(waypoints) < 2 || len(strategies) == 0 {
		return nil
	}
	if singleAggregated {
		leg := RouteLeg{
			Index:           1,
			Strategy:        strategies[0],
			From:            waypoints[0],
			To:              waypoints[len(waypoints)-1],
			DistanceMeters:  segDists[0],
			DurationSeconds: segDurs[0],
		}
		if len(waypoints) > 2 {
			leg.Via = waypoints[1 : len(waypoints)-1]
		}
		leg.AmapNavURL = buildAmapNavURL(mode, leg)
		return []RouteLeg{leg}
	}

	legs := make([]RouteLeg, 0, len(strategies))
	for i, strat := range strategies {
		if len(legs) > 0 && legs[len(legs)-1].Strategy == strat && strat != "direct" {
			last := &legs[len(legs)-1]
			last.Via = append(last.Via, waypoints[i])
			last.To = waypoints[i+1]
			last.DistanceMeters += segDists[i]
			last.DurationSeconds += segDurs[i]
			continue
		}
		legs = append(legs, RouteLeg{
			Index:           len(legs) + 1,
			Strategy:        strat,
			From:            waypoints[i],
			To:              waypoints[i+1],
			DistanceMeters:  segDists[i],
			DurationSeconds: segDurs[i],
		})
	}
	for i := range legs {
		legs[i].AmapNavURL = buildAmapNavURL(mode, legs[i])
	}
	return legs
}

func buildAmapNavURL(mode string, leg RouteLeg) string {
	fLng, fLat := geo.WGS84ToGCJ02(leg.From[0], leg.From[1])
	tLng, tLat := geo.WGS84ToGCJ02(leg.To[0], leg.To[1])

	amapMode := "ride"
	switch mode {
	case "walking":
		amapMode = "walk"
	case "driving":
		amapMode = "car"
	}

	vals := url.Values{
		"from":       {fmt.Sprintf("%.6f,%.6f,起点", fLng, fLat)},
		"to":         {fmt.Sprintf("%.6f,%.6f,终点", tLng, tLat)},
		"mode":       {amapMode},
		"coordinate": {"gaode"},
		"callnative": {"1"},
	}
	if len(leg.Via) > 0 {
		vLng, vLat := geo.WGS84ToGCJ02(leg.Via[0][0], leg.Via[0][1])
		vals.Set("via", fmt.Sprintf("%.6f,%.6f,途经点", vLng, vLat))
	}
	if mode == "driving" {
		switch leg.Strategy {
		case "avoid-jam":
			vals.Set("policy", "1")
		case "national":
			vals.Set("policy", "2")
		default:
			vals.Set("policy", "0")
		}
	}
	return "https://uri.amap.com/navigation?" + vals.Encode()
}

type amapTMC struct {
	Status   string `json:"status"`
	Polyline string `json:"polyline"`
}

func trafficColor(status string) string {
	switch strings.TrimSpace(status) {
	case "畅通":
		return "#16a34a"
	case "缓行":
		return "#f59e0b"
	case "拥堵":
		return "#dc2626"
	case "严重拥堵":
		return "#7f1d1d"
	default:
		return "#2563eb"
	}
}

func appendTrafficSegments(dst []TrafficSegment, tmcs []amapTMC) []TrafficSegment {
	for _, tmc := range tmcs {
		coords := appendAmapPolylineWGS84(nil, tmc.Polyline)
		if len(coords) < 2 {
			continue
		}
		status := strings.TrimSpace(tmc.Status)
		if status == "" {
			status = "未知"
		}
		if len(dst) > 0 && dst[len(dst)-1].Status == status {
			last := &dst[len(dst)-1]
			for _, pt := range coords {
				last.Coordinates = appendCoordDedup(last.Coordinates, pt[0], pt[1])
			}
			continue
		}
		dst = append(dst, TrafficSegment{
			Status:      status,
			Color:       trafficColor(status),
			Coordinates: coords,
		})
	}
	return dst
}

func (s *Service) fetchAmapV3DirectionSegment(ctx context.Context, kind, origin, dest, waypoints, strategy, avoidPolygons string) (float64, float64, []string, []amapTMC, error) {
	params := url.Values{
		"key":         {s.cfg.AmapKey},
		"origin":      {origin},
		"destination": {dest},
	}
	if kind == "driving" {
		params.Set("extensions", "all")
	}
	if waypoints != "" {
		params.Set("waypoints", waypoints)
	}
	if strategy != "" {
		params.Set("strategy", strategy)
	}
	if avoidPolygons != "" {
		params.Set("avoidpolygons", avoidPolygons)
	}
	endpoint := fmt.Sprintf("https://restapi.amap.com/v3/direction/%s?", kind) + params.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return 0, 0, nil, nil, err
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return 0, 0, nil, nil, fmt.Errorf("amap %s request: %w", kind, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return 0, 0, nil, nil, fmt.Errorf("amap %s status: %d", kind, resp.StatusCode)
	}

	var payload struct {
		Status string `json:"status"`
		Info   string `json:"info"`
		Route  struct {
			Paths []struct {
				Distance string `json:"distance"`
				Duration string `json:"duration"`
				Steps    []struct {
					Polyline string    `json:"polyline"`
					TMCs     []amapTMC `json:"tmcs"`
				} `json:"steps"`
			} `json:"paths"`
		} `json:"route"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return 0, 0, nil, nil, fmt.Errorf("decode amap %s: %w", kind, err)
	}
	if payload.Status != "1" || len(payload.Route.Paths) == 0 {
		return 0, 0, nil, nil, fmt.Errorf("amap %s error: %s", kind, payload.Info)
	}

	path := payload.Route.Paths[0]
	dist, _ := strconv.ParseFloat(path.Distance, 64)
	dur, _ := strconv.ParseFloat(path.Duration, 64)
	polylines := make([]string, 0, len(path.Steps))
	var tmcs []amapTMC
	for _, st := range path.Steps {
		if st.Polyline != "" {
			polylines = append(polylines, st.Polyline)
		}
		if len(st.TMCs) > 0 {
			tmcs = append(tmcs, st.TMCs...)
		}
	}
	return dist, dur, polylines, tmcs, nil
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
	switch mode {
	case "walking":
		profile = "foot"
	case "driving":
		profile = "driving"
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

func appendCoordDedup(dst [][]float64, lng, lat float64) [][]float64 {
	if len(dst) > 0 {
		last := dst[len(dst)-1]
		if last[0] == lng && last[1] == lat {
			return dst
		}
	}
	return append(dst, []float64{lng, lat})
}

func haversineRouteMeters(lng1, lat1, lng2, lat2 float64) float64 {
	const earthR = 6371008.8
	rad := math.Pi / 180
	dLat := (lat2 - lat1) * rad
	dLng := (lng2 - lng1) * rad
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*rad)*math.Cos(lat2*rad)*math.Sin(dLng/2)*math.Sin(dLng/2)
	return 2 * earthR * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
}

func isLikelyInChina(lng, lat float64) bool {
	return lng >= 72.004 && lng <= 137.8347 && lat >= 0.8293 && lat <= 55.8271
}
