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
