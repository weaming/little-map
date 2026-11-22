package service

import (
	"context"
	"strings"
	"testing"

	"little-map/pkg/config"
)

func TestBypassTollFilterAndCandidateMatrix(t *testing.T) {
	line := [][]float64{
		{116.30, 39.90},
		{116.32, 39.90},
		{116.34, 39.90},
		{116.36, 39.90},
		{116.38, 39.90},
	}

	poly := buildPolylineCorridorGCJ02(line, 900)
	pts := strings.Split(poly, ";")
	if len(pts) != 11 || pts[0] != pts[len(pts)-1] {
		t.Fatalf("unexpected corridor polygon vertices=%d", len(pts))
	}

	// 验证收费站过滤：排除主线/枢纽/服务区/过远/距拥堵过近，保留真实喇叭形收费站（无论左右侧）
	pois := []bypassCandidatePOI{
		{Name: "京港澳主线收费站", Lng: 116.35, Lat: 39.9005},
		{Name: "大兴枢纽互通", Lng: 116.34, Lat: 39.9005},
		{Name: "窦店服务区", Lng: 116.34, Lat: 39.9005},
		{Name: "太远收费站", Lng: 116.34, Lat: 39.92},
		{Name: "紧贴拥堵口收费站", Lng: 116.379, Lat: 39.9005}, // 距末端 < 600m，应被跳过
		{Name: "良乡收费站(西口)", Lng: 116.35, Lat: 39.904},  // 左侧喇叭形收费站广场（距线 ~440m），应保留
		{Name: "阎村收费站", Lng: 116.32, Lat: 39.896},      // 右侧收费站，应保留且排在较远位置
	}

	ranked := filterAndRankTollStations(line, pois, true, 0)
	if len(ranked) != 2 {
		t.Fatalf("expected 2 usable toll stations, got %d: %+v", len(ranked), ranked)
	}
	if ranked[0].Name != "良乡收费站" || ranked[1].Name != "阎村收费站" {
		t.Fatalf("unexpected ranked order: %+v", ranked)
	}

	// 验证连续拥堵团合并
	traffic := []TrafficSegment{
		{Status: "畅通", Color: "#22c55e", Coordinates: [][]float64{{116.30, 39.90}, {116.32, 39.90}}},
		{Status: "缓行", Color: "#f59e0b", Coordinates: [][]float64{{116.32, 39.90}, {116.34, 39.90}}},
		{Status: "拥堵", Color: "#ef4444", Coordinates: [][]float64{{116.34, 39.90}, {116.36, 39.90}}},
		{Status: "畅通", Color: "#22c55e", Coordinates: [][]float64{{116.36, 39.90}, {116.38, 39.90}}},
	}
	lo, hi, merged := mergeContiguousJamRange(line, traffic, 2, traffic[2].Coordinates)
	if lo != 1 || hi != 3 || len(merged) != 3 {
		t.Fatalf("expected merged range [1..3], got [%d..%d] len=%d", lo, hi, len(merged))
	}

	// 验证候选方案矩阵包含官方避堵 + 双边 + 延迟上高速 + 提前下高速（封顶 4 个）
	plans := buildBypassCandidatePlans(
		line[0], line[4], "highway",
		[]bypassCandidatePOI{{Name: "良乡收费站", Lng: 116.32, Lat: 39.90}},
		[]bypassCandidatePOI{{Name: "琉璃河收费站", Lng: 116.36, Lat: 39.90}},
		5000, 5000,
	)
	if len(plans) != 4 {
		t.Fatalf("expected 4 candidate plans, got %d", len(plans))
	}
	if plans[0].Kind != "official" || plans[1].Kind != "both" || plans[2].Kind != "delay_entry" || plans[3].Kind != "early_exit" {
		t.Fatalf("unexpected plan kinds: %+v", plans)
	}

	// 离线无 Key 时调用入口应稳定返回 official 方案不报错
	svc := New(nil, &config.Config{})
	res, err := svc.FindHighwayBypassAnchors(context.Background(), BypassInput{
		RouteCoords:       line,
		TrafficSegments:   traffic,
		ClickedSegmentIdx: 2,
		AvoidSegment:      traffic[2].Coordinates,
	})
	if err != nil {
		t.Fatalf("FindHighwayBypassAnchors failed: %v", err)
	}
	if res.RecommendedID != "official" || len(res.Options) == 0 {
		t.Fatalf("unexpected offline result: %+v", res)
	}
}
