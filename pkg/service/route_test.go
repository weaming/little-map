package service

import "testing"

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
