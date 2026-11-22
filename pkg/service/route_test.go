package service

import (
	"context"
	"testing"

	"little-map/pkg/config"
)

func TestAppendAmapPolylineAndSimplifyLine(t *testing.T) {
	var merged [][]float64
	merged = appendAmapPolylineWGS84(merged, "116.3974,39.9093;116.4000,39.9100")
	// 重复衔接点应自动去重
	merged = appendAmapPolylineWGS84(merged, "116.4000,39.9100;116.4050,39.9120")
	if len(merged) != 3 {
		t.Fatalf("expected 3 deduplicated points, got %d", len(merged))
	}

	// 抽稀后应严格保留起点与终点且不超过 maxVertices
	dense := make([][]float64, 0, 1200)
	for i := range 1200 {
		dense = append(dense, []float64{116.0 + float64(i)*0.0001, 39.9})
	}
	simplified := simplifyLineCoords(dense, maxRouteVertices)
	if len(simplified) != maxRouteVertices {
		t.Fatalf("expected %d points, got %d", maxRouteVertices, len(simplified))
	}
	if simplified[0][0] != roundCoord(dense[0][0]) || simplified[len(simplified)-1][0] != roundCoord(dense[len(dense)-1][0]) {
		t.Fatalf("endpoints not preserved after simplify")
	}
}

func TestDirectSegmentRoute(t *testing.T) {
	svc := New(nil, &config.Config{})
	res, err := svc.PlanRoute(context.Background(), RouteInput{
		Mode:         "walking",
		Waypoints:    [][]float64{{116.391, 39.907}, {116.401, 39.907}},
		SegmentModes: []string{"direct"},
		Provider:     "osrm",
	})
	if err != nil {
		t.Fatalf("direct route failed: %v", err)
	}
	if res.DistanceMeters < 800 || res.DistanceMeters > 900 {
		t.Fatalf("unexpected direct distance: %f", res.DistanceMeters)
	}
	if res.DurationSeconds <= 0 {
		t.Fatalf("expected positive duration")
	}
}

func TestBuildRouteLegsAndAvoidPolygons(t *testing.T) {
	wps := [][]float64{
		{116.3, 39.9},
		{116.4, 39.9},
		{116.5, 39.9},
		{116.6, 39.9},
	}
	// 前两段同为 highway 应合并为 1 段接力导航，第 3 段为 national 拆为第 2 段
	legs := buildRouteLegs("driving", wps, []string{"highway", "highway", "national"}, []float64{10000, 15000, 8000}, []float64{600, 900, 700}, false)
	if len(legs) != 2 {
		t.Fatalf("expected 2 merged navigation legs, got %d", len(legs))
	}
	if legs[0].Strategy != "highway" || len(legs[0].Via) != 1 || legs[0].DistanceMeters != 25000 {
		t.Fatalf("unexpected leg[0]: %+v", legs[0])
	}
	if legs[1].Strategy != "national" || legs[1].AmapNavURL == "" {
		t.Fatalf("unexpected leg[1]: %+v", legs[1])
	}

	avoid := buildAmapAvoidPolygons([][]float64{{116.3974, 39.9093}}, [][][]float64{
		{{116.30, 39.90}, {116.33, 39.92}},
	})
	if avoid == "" || len(avoid) < 60 {
		t.Fatalf("unexpected avoidpolygons: %q", avoid)
	}

	segs := appendTrafficSegments(nil, []amapTMC{
		{Status: "畅通", Polyline: "116.30,39.90;116.31,39.90"},
		{Status: "畅通", Polyline: "116.31,39.90;116.32,39.90"},
		{Status: "拥堵", Polyline: "116.32,39.90;116.33,39.90"},
	})
	if len(segs) != 2 || segs[0].Color != "#16a34a" || len(segs[0].Coordinates) != 3 || segs[1].Color != "#dc2626" {
		t.Fatalf("unexpected merged traffic segments: %+v", segs)
	}
}
