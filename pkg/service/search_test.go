package service

import (
	"encoding/json"
	"testing"
)

func TestParseAmapPolylineToPolygon(t *testing.T) {
	// 两个环，后者顶点数更多，应选主多边形并完成 GCJ-02 -> WGS-84 纠偏和首尾闭合
	poly := "116.30,39.90;116.31,39.90;116.31,39.91|116.38,39.90;116.41,39.90;116.41,39.92;116.38,39.92"
	geom := parseAmapPolylineToPolygon(poly)
	if geom == nil || geom.Type != "Polygon" {
		t.Fatalf("expected valid Polygon, got %+v", geom)
	}

	var rings [][][]float64
	if err := json.Unmarshal(geom.Coordinates, &rings); err != nil {
		t.Fatalf("unmarshal polygon: %v", err)
	}
	if len(rings) != 1 || len(rings[0]) != 5 {
		t.Fatalf("expected closed ring of 5 points, got %d", len(rings[0]))
	}
	first, last := rings[0][0], rings[0][len(rings[0])-1]
	if first[0] != last[0] || first[1] != last[1] {
		t.Fatalf("ring is not closed: first=%v last=%v", first, last)
	}
}

func TestParseOSMGeoJSONAndSimplify(t *testing.T) {
	// 构造 400 个顶点的 Polygon，应抽稀到 <= maxBoundaryVertices+1
	ring := make([][]float64, 0, 401)
	for i := range 400 {
		ring = append(ring, []float64{116.3 + float64(i)*0.0001, 39.9 + float64(i%20)*0.0001})
	}
	ring = append(ring, ring[0])
	raw, _ := json.Marshal(map[string]any{
		"type":        "Polygon",
		"coordinates": [][][]float64{ring},
	})

	geom := parseOSMGeoJSONToPolygon(raw)
	if geom == nil || geom.Type != "Polygon" {
		t.Fatalf("expected valid simplified Polygon")
	}

	var out [][][]float64
	if err := json.Unmarshal(geom.Coordinates, &out); err != nil {
		t.Fatalf("unmarshal simplified polygon: %v", err)
	}
	if len(out[0]) > maxBoundaryVertices+1 || len(out[0]) < 4 {
		t.Fatalf("unexpected simplified ring length: %d", len(out[0]))
	}
}
