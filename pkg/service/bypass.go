package service

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"little-map/pkg/geo"
)

const (
	bypassMaxSearchDistM   = 24000.0 // 上下游最多沿高速外扩 24km 搜收费站
	bypassWindowStepM      = 8000.0  // 每次短走廊搜索步长 8km（防弯道偏离 & 25 条截断）
	bypassCorridorHalfW    = 900.0   // 走廊半宽 900m（覆盖喇叭形收费站广场）
	bypassMaxDistToLineM   = 950.0   // 收费站距高速中心线最大允许距离
	bypassMinJamGapM       = 600.0   // 跳过距拥堵边界不足 600m 的收费站（防出口已堵死）
	bypassJamMergeGapM     = 1500.0  // 合并相邻连续拥堵段的最大间隙
	bypassSingleSideMaxM   = 30000.0 // 拥堵距起/终点 < 30km 时将延迟上/提前下纳入赛马
	bypassMaxDetourRatio   = 1.38    // 真实算路里程超过原路线 1.38 倍视为掉头/极端绕路废案
	bypassCoreAvoidMinDist = 120.0   // 校验新路线是否仍穿过拥堵核心的最小距离阈值
	bypassMaxRaceOptions   = 4       // 最多真实算路比选 4 个方案（控制 QPS 与延迟）
)

// BypassInput 定义智能绕堵赛马请求参数（WGS-84）。
type BypassInput struct {
	RouteCoords        [][]float64      `json:"route_coords"`
	TrafficSegments    []TrafficSegment `json:"traffic_segments,omitempty"`
	ClickedSegmentIdx  int              `json:"clicked_segment_idx,omitempty"`
	AvoidSegment       [][]float64      `json:"avoid_segment"`
	StartPoint         []float64        `json:"start_point,omitempty"`
	EndPoint           []float64        `json:"end_point,omitempty"`
	OrigMode           string           `json:"orig_mode,omitempty"`
	OrigDurationSec    float64          `json:"orig_duration_seconds,omitempty"`
	OrigDistanceMeters float64          `json:"orig_distance_meters,omitempty"`
	Provider           string           `json:"provider,omitempty"`
}

// BypassAnchor 表示绕堵衔接收费站锚点（WGS-84）。
type BypassAnchor struct {
	Name string  `json:"name"`
	Lng  float64 `json:"lng"`
	Lat  float64 `json:"lat"`
}

// BypassOption 表示经过候选构造与真实算路验证的单个绕堵方案。
type BypassOption struct {
	ID              string        `json:"id"`
	Label           string        `json:"label"`
	Summary         string        `json:"summary"`
	Kind            string        `json:"kind"` // official | both | delay_entry | early_exit
	Before          *BypassAnchor `json:"before,omitempty"`
	After           *BypassAnchor `json:"after,omitempty"`
	SegmentModes    []string      `json:"segment_modes"`
	DistanceMeters  float64       `json:"distance_meters"`
	DurationSeconds float64       `json:"duration_seconds"`
	DeltaSeconds    float64       `json:"delta_seconds"`
	DeltaMeters     float64       `json:"delta_meters"`
}

// BypassResult 返回赛马胜出的推荐方案及全部合法备选方案。
type BypassResult struct {
	RecommendedID string         `json:"recommended_id"`
	Summary       string         `json:"summary"`
	MergedJamPts  int            `json:"merged_jam_pts"`
	Options       []BypassOption `json:"options"`
}

type bypassCandidatePOI struct {
	Name        string
	Lng         float64
	Lat         float64
	DistToLine  float64
	DistFromJam float64
}

type bypassCandidatePlan struct {
	ID           string
	Kind         string
	Label        string
	Before       *BypassAnchor
	After        *BypassAnchor
	Waypoints    [][]float64
	SegmentModes []string
	UseAvoidSeg  bool
}

// FindHighwayBypassAnchors 执行「拥堵团合并 → 收费站分段搜索 → 多方案真实算路赛马 → 负优化兜底」。
func (s *Service) FindHighwayBypassAnchors(ctx context.Context, in BypassInput) (*BypassResult, error) {
	if len(in.RouteCoords) < 4 || len(in.AvoidSegment) < 2 {
		return nil, fmt.Errorf("%w: route_coords (>=4) and avoid_segment (>=2) are required", ErrInvalidInput)
	}

	origMode := normalizeSegStrategy("driving", []string{in.OrigMode}, 0)
	if origMode == "direct" {
		origMode = "highway"
	}

	startPt := in.RouteCoords[0]
	if len(in.StartPoint) >= 2 {
		startPt = in.StartPoint
	}
	endPt := in.RouteCoords[len(in.RouteCoords)-1]
	if len(in.EndPoint) >= 2 {
		endPt = in.EndPoint
	}

	// 阶段 1：拥堵团合并，避免仅绕开点到的 500m 碎段
	lo, hi, mergedJam := mergeContiguousJamRange(in.RouteCoords, in.TrafficSegments, in.ClickedSegmentIdx, in.AvoidSegment)

	// 阶段 2：分段短走廊只搜收费站(180200)，上下游各取最多 2 个候选
	var upExits, downEntries []bypassCandidatePOI
	if s.cfg.AmapKey != "" {
		if lo > 0 {
			upExits = s.searchTollStationsAlong(ctx, in.RouteCoords, lo, true, 2)
		}
		if hi < len(in.RouteCoords)-1 {
			downEntries = s.searchTollStationsAlong(ctx, in.RouteCoords, hi, false, 2)
		}
	}

	// 阶段 3：构造 ≤ 4 个候选方案矩阵（官方避堵基准 + 双边 + 延迟上高速 + 提前下高速）
	distFromStart := lineDistanceBetween(in.RouteCoords, 0, lo)
	distToEnd := lineDistanceBetween(in.RouteCoords, hi, len(in.RouteCoords)-1)
	plans := buildBypassCandidatePlans(startPt, endPt, origMode, upExits, downEntries, distFromStart, distToEnd)

	// 阶段 4：真实算路赛马与硬校验（无高德 Key 时跳过外部算路，仅返回结构化候选）
	options := s.evaluateBypassPlans(ctx, plans, mergedJam, in.OrigDurationSec, in.OrigDistanceMeters, in.Provider)
	if len(options) == 0 {
		// 极端保底：至少返回官方避堵方案
		options = append(options, BypassOption{
			ID:           "official",
			Kind:         "official",
			Label:        "官方避堵",
			Summary:      "保持高德官方避堵方案",
			SegmentModes: []string{"avoid-jam"},
		})
	}

	best := options[0]
	summary := buildBypassHeadline(best, in.OrigDurationSec)
	return &BypassResult{
		RecommendedID: best.ID,
		Summary:       summary,
		MergedJamPts:  len(mergedJam),
		Options:       options,
	}, nil
}

// mergeContiguousJamRange 沿当前路线合并与点击段相连的红/黄拥堵段（间隙 < 1.5km），返回完整拥堵索引区间与坐标。
func mergeContiguousJamRange(
	routeCoords [][]float64,
	traffic []TrafficSegment,
	clickedIdx int,
	avoidSeg [][]float64,
) (int, int, [][]float64) {
	loIdx := nearestVertexIndex(routeCoords, avoidSeg[0])
	hiIdx := nearestVertexIndex(routeCoords, avoidSeg[len(avoidSeg)-1])
	lo := min(loIdx, hiIdx)
	hi := max(loIdx, hiIdx)

	if len(traffic) == 0 || clickedIdx < 0 || clickedIdx >= len(traffic) {
		return lo, hi, routeCoords[lo : hi+1]
	}

	// 向左合并相邻拥堵段
	curStart := traffic[clickedIdx].Coordinates[0]
	for i := clickedIdx - 1; i >= 0; i-- {
		seg := traffic[i]
		if len(seg.Coordinates) < 2 || !isCongestedTraffic(seg) {
			break
		}
		segEnd := seg.Coordinates[len(seg.Coordinates)-1]
		if haversineRouteMeters(segEnd[0], segEnd[1], curStart[0], curStart[1]) > bypassJamMergeGapM {
			break
		}
		idx := nearestVertexIndex(routeCoords, seg.Coordinates[0])
		if idx < lo {
			lo = idx
		}
		curStart = seg.Coordinates[0]
	}

	// 向右合并相邻拥堵段
	clickedCoords := traffic[clickedIdx].Coordinates
	curEnd := clickedCoords[len(clickedCoords)-1]
	for i := clickedIdx + 1; i < len(traffic); i++ {
		seg := traffic[i]
		if len(seg.Coordinates) < 2 || !isCongestedTraffic(seg) {
			break
		}
		segStart := seg.Coordinates[0]
		if haversineRouteMeters(curEnd[0], curEnd[1], segStart[0], segStart[1]) > bypassJamMergeGapM {
			break
		}
		idx := nearestVertexIndex(routeCoords, seg.Coordinates[len(seg.Coordinates)-1])
		if idx > hi {
			hi = idx
		}
		curEnd = seg.Coordinates[len(seg.Coordinates)-1]
	}

	if lo < 0 {
		lo = 0
	}
	if hi >= len(routeCoords) {
		hi = len(routeCoords) - 1
	}
	if hi <= lo {
		return lo, hi, avoidSeg
	}
	return lo, hi, routeCoords[lo : hi+1]
}

func isCongestedTraffic(seg TrafficSegment) bool {
	if strings.Contains(seg.Status, "拥堵") || strings.Contains(seg.Status, "缓行") || strings.Contains(seg.Status, "严重") {
		return true
	}
	c := strings.ToLower(strings.TrimSpace(seg.Color))
	return c == "#ef4444" || c == "#991b1b" || c == "#f59e0b"
}

// searchTollStationsAlong 从拥堵边界沿轨迹按 8km 短窗口向外步进，仅搜收费站(180200)，凑够 limit 个即停。
func (s *Service) searchTollStationsAlong(
	ctx context.Context,
	routeCoords [][]float64,
	anchorIdx int,
	upstream bool,
	limit int,
) []bypassCandidatePOI {
	collected := make([]bypassCandidatePOI, 0, limit*2)
	cursor := anchorIdx
	searchedDist := 0.0

	for searchedDist < bypassMaxSearchDistM && len(collected) < limit {
		var nextCursor int
		var subLine [][]float64
		if upstream {
			if cursor <= 0 {
				break
			}
			nextCursor = walkBackAlongLine(routeCoords, cursor, bypassWindowStepM)
			subLine = routeCoords[nextCursor : cursor+1]
		} else {
			if cursor >= len(routeCoords)-1 {
				break
			}
			nextCursor = walkForwardAlongLine(routeCoords, cursor, bypassWindowStepM)
			subLine = routeCoords[cursor : nextCursor+1]
		}
		if len(subLine) < 2 || nextCursor == cursor {
			break
		}

		if searchedDist > 0 || !upstream {
			if err := waitAmapGap(ctx); err != nil {
				break
			}
		}

		pois, err := s.searchAmapCorridorTollStations(ctx, subLine)
		if err != nil {
			slog.Warn("amap toll station corridor search failed", "upstream", upstream, "err", err)
		} else {
			windowCandidates := filterAndRankTollStations(subLine, pois, upstream, searchedDist)
			collected = mergeDedupTollStations(collected, windowCandidates)
		}

		searchedDist += lineDistanceBetween(routeCoords, min(cursor, nextCursor), max(cursor, nextCursor))
		cursor = nextCursor
	}

	sort.Slice(collected, func(i, j int) bool {
		return collected[i].DistFromJam < collected[j].DistFromJam
	})
	if len(collected) > limit {
		return collected[:limit]
	}
	return collected
}

func waitAmapGap(ctx context.Context) error {
	timer := time.NewTimer(amapRequestGap)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// filterAndRankTollStations 过滤非下道收费站（主线/省界/枢纽/服务区）及距拥堵过近/距线过远站点，按距拥堵距离排序。
func filterAndRankTollStations(
	subLine [][]float64,
	pois []bypassCandidatePOI,
	isUpstream bool,
	baseOffsetM float64,
) []bypassCandidatePOI {
	if len(subLine) < 2 || len(pois) == 0 {
		return nil
	}
	cumDist := make([]float64, len(subLine))
	for i := 1; i < len(subLine); i++ {
		cumDist[i] = cumDist[i-1] + haversineRouteMeters(subLine[i-1][0], subLine[i-1][1], subLine[i][0], subLine[i][1])
	}
	totalLen := cumDist[len(cumDist)-1]

	out := make([]bypassCandidatePOI, 0, len(pois))
	for _, poi := range pois {
		if !isUsableTollStation(poi.Name) {
			continue
		}
		projDistAlong, distToLine := projectPointOntoLine(subLine, cumDist, []float64{poi.Lng, poi.Lat})
		if distToLine > bypassMaxDistToLineM {
			continue
		}
		localDistFromJam := projDistAlong
		if isUpstream {
			localDistFromJam = totalLen - projDistAlong
		}
		distFromJam := baseOffsetM + localDistFromJam
		if distFromJam < bypassMinJamGapM {
			continue
		}
		out = append(out, bypassCandidatePOI{
			Name:        cleanTollStationName(poi.Name),
			Lng:         poi.Lng,
			Lat:         poi.Lat,
			DistToLine:  distToLine,
			DistFromJam: distFromJam,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].DistFromJam < out[j].DistFromJam
	})
	return out
}

func isUsableTollStation(name string) bool {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return false
	}
	excluded := []string{"主线", "省界", "枢纽", "服务区", "停车区", "管理处", "养护", "公安", "检查站"}
	for _, kw := range excluded {
		if strings.Contains(trimmed, kw) {
			return false
		}
	}
	return true
}

func cleanTollStationName(name string) string {
	trimmed := strings.TrimSpace(name)
	if idx := strings.Index(trimmed, "("); idx > 0 {
		trimmed = strings.TrimSpace(trimmed[:idx])
	}
	if idx := strings.Index(trimmed, "（"); idx > 0 {
		trimmed = strings.TrimSpace(trimmed[:idx])
	}
	return trimmed
}

func mergeDedupTollStations(existing, incoming []bypassCandidatePOI) []bypassCandidatePOI {
	out := append([]bypassCandidatePOI{}, existing...)
	for _, cand := range incoming {
		dup := false
		for i := range out {
			if out[i].Name == cand.Name || haversineRouteMeters(out[i].Lng, out[i].Lat, cand.Lng, cand.Lat) < 400 {
				if cand.DistToLine < out[i].DistToLine {
					out[i] = cand
				}
				dup = true
				break
			}
		}
		if !dup {
			out = append(out, cand)
		}
	}
	return out
}

// buildBypassCandidatePlans 构造最多 4 个候选方案矩阵（含官方避堵基准、双边、延迟上高速、提前下高速）。
func buildBypassCandidatePlans(
	startPt, endPt []float64,
	origMode string,
	upExits, downEntries []bypassCandidatePOI,
	distFromStart, distToEnd float64,
) []bypassCandidatePlan {
	plans := make([]bypassCandidatePlan, 0, bypassMaxRaceOptions)

	// 1. 基准：官方避堵
	plans = append(plans, bypassCandidatePlan{
		ID:           "official",
		Kind:         "official",
		Label:        "官方避堵",
		Waypoints:    [][]float64{startPt, endPt},
		SegmentModes: []string{"avoid-jam"},
		UseAvoidSeg:  true,
	})

	toAnchor := func(p bypassCandidatePOI, suffix string) *BypassAnchor {
		return &BypassAnchor{Name: p.Name + suffix, Lng: p.Lng, Lat: p.Lat}
	}

	// 2. 双边绕堵（最近上游收费站下 → 最近下游收费站上）
	if len(upExits) > 0 && len(downEntries) > 0 {
		b := toAnchor(upExits[0], "(下)")
		a := toAnchor(downEntries[0], "(上)")
		plans = append(plans, bypassCandidatePlan{
			ID:           "both_1",
			Kind:         "both",
			Label:        fmt.Sprintf("双边(%s下→%s上)", shortStationLabel(upExits[0].Name), shortStationLabel(downEntries[0].Name)),
			Before:       b,
			After:        a,
			Waypoints:    [][]float64{startPt, {b.Lng, b.Lat}, {a.Lng, a.Lat}, endPt},
			SegmentModes: []string{origMode, "national", origMode},
		})
	}

	// 3. 延迟上高速（拥堵距起点 < 30km 时参与赛马）
	if len(downEntries) > 0 && distFromStart < bypassSingleSideMaxM && len(plans) < bypassMaxRaceOptions {
		a := toAnchor(downEntries[0], "(上)")
		plans = append(plans, bypassCandidatePlan{
			ID:           "delay_entry",
			Kind:         "delay_entry",
			Label:        fmt.Sprintf("延迟上高速(%s上)", shortStationLabel(downEntries[0].Name)),
			After:        a,
			Waypoints:    [][]float64{startPt, {a.Lng, a.Lat}, endPt},
			SegmentModes: []string{"national", origMode},
		})
	}

	// 4. 提前下高速（拥堵距终点 < 30km 时参与赛马）
	if len(upExits) > 0 && distToEnd < bypassSingleSideMaxM && len(plans) < bypassMaxRaceOptions {
		b := toAnchor(upExits[0], "(下)")
		plans = append(plans, bypassCandidatePlan{
			ID:           "early_exit",
			Kind:         "early_exit",
			Label:        fmt.Sprintf("提前下高速(%s下)", shortStationLabel(upExits[0].Name)),
			Before:       b,
			Waypoints:    [][]float64{startPt, {b.Lng, b.Lat}, endPt},
			SegmentModes: []string{origMode, "national"},
		})
	}

	// 5. 若仍有配额，用次近收费站补一个备选双边方案
	if len(plans) < bypassMaxRaceOptions && len(upExits) > 0 && len(downEntries) > 0 {
		var altUp, altDown *bypassCandidatePOI
		if len(upExits) > 1 {
			altUp = &upExits[1]
			altDown = &downEntries[0]
		} else if len(downEntries) > 1 {
			altUp = &upExits[0]
			altDown = &downEntries[1]
		}
		if altUp != nil && altDown != nil {
			b := toAnchor(*altUp, "(下)")
			a := toAnchor(*altDown, "(上)")
			plans = append(plans, bypassCandidatePlan{
				ID:           "both_2",
				Kind:         "both",
				Label:        fmt.Sprintf("备选(%s下→%s上)", shortStationLabel(altUp.Name), shortStationLabel(altDown.Name)),
				Before:       b,
				After:        a,
				Waypoints:    [][]float64{startPt, {b.Lng, b.Lat}, {a.Lng, a.Lat}, endPt},
				SegmentModes: []string{origMode, "national", origMode},
			})
		}
	}

	return plans
}

func shortStationLabel(name string) string {
	return strings.TrimSuffix(strings.TrimSpace(name), "收费站")
}

// evaluateBypassPlans 对候选方案逐一调用高德真实算路，过滤掉掉头绕远/仍穿拥堵核心的废案，按耗时升序返回。
func (s *Service) evaluateBypassPlans(
	ctx context.Context,
	plans []bypassCandidatePlan,
	mergedJam [][]float64,
	origDurationSec, origDistanceMeters float64,
	provider string,
) []BypassOption {
	if s.cfg.AmapKey == "" {
		// 离线/单元测试降级：不调外部算路，按构造顺序返回结构化方案
		out := make([]BypassOption, 0, len(plans))
		for _, p := range plans {
			out = append(out, BypassOption{
				ID:           p.ID,
				Kind:         p.Kind,
				Label:        p.Label,
				Summary:      p.Label,
				Before:       p.Before,
				After:        p.After,
				SegmentModes: p.SegmentModes,
			})
		}
		return out
	}

	jamCoreMid := mergedJam[len(mergedJam)/2]
	jamLenM := lineDistanceBetween(mergedJam, 0, len(mergedJam)-1)
	evaluated := make([]BypassOption, 0, len(plans))

	for i, plan := range plans {
		if i > 0 {
			if err := waitAmapGap(ctx); err != nil {
				break
			}
		}

		routeIn := RouteInput{
			Mode:         "driving",
			Waypoints:    plan.Waypoints,
			SegmentModes: plan.SegmentModes,
			Provider:     provider,
		}
		if plan.UseAvoidSeg && len(mergedJam) >= 2 {
			routeIn.AvoidSegments = [][][]float64{mergedJam}
		}

		res, err := s.PlanRoute(ctx, routeIn)
		if err != nil {
			slog.Warn("bypass candidate route failed", "id", plan.ID, "err", err)
			continue
		}

		// 硬校验 1：拆段方案里程暴增（>1.38 倍）说明出现对向掉头或山区无平行路，直接淘汰
		if plan.Kind != "official" && origDistanceMeters > 0 && res.DistanceMeters > origDistanceMeters*bypassMaxDetourRatio {
			slog.Info("bypass candidate rejected by detour ratio", "id", plan.ID, "dist", res.DistanceMeters, "orig", origDistanceMeters)
			continue
		}

		// 硬校验 2：拆段方案若仍穿过长拥堵核心（<120m），说明未成功绕开拥堵，淘汰
		if plan.Kind != "official" && jamLenM > 1000 {
			var coords [][]float64
			if err := json.Unmarshal(res.Geometry.Coordinates, &coords); err == nil && len(coords) >= 2 {
				_, distToCore := nearestVertexWithDist(coords, jamCoreMid)
				if distToCore < bypassCoreAvoidMinDist {
					slog.Info("bypass candidate rejected: still crosses jam core", "id", plan.ID, "distToCore", distToCore)
					continue
				}
			}
		}

		deltaSec := 0.0
		if origDurationSec > 0 {
			deltaSec = res.DurationSeconds - origDurationSec
		}
		deltaDist := 0.0
		if origDistanceMeters > 0 {
			deltaDist = res.DistanceMeters - origDistanceMeters
		}

		evaluated = append(evaluated, BypassOption{
			ID:              plan.ID,
			Kind:            plan.Kind,
			Label:           plan.Label,
			Summary:         formatOptionSummary(plan.Label, res.DurationSeconds, deltaSec),
			Before:          plan.Before,
			After:           plan.After,
			SegmentModes:    plan.SegmentModes,
			DistanceMeters:  res.DistanceMeters,
			DurationSeconds: res.DurationSeconds,
			DeltaSeconds:    deltaSec,
			DeltaMeters:     deltaDist,
		})
	}

	sort.Slice(evaluated, func(i, j int) bool {
		if math.Abs(evaluated[i].DurationSeconds-evaluated[j].DurationSeconds) > 30 {
			return evaluated[i].DurationSeconds < evaluated[j].DurationSeconds
		}
		return evaluated[i].DistanceMeters < evaluated[j].DistanceMeters
	})
	return evaluated
}

func formatOptionSummary(label string, durationSec, deltaSec float64) string {
	durStr := formatBypassDuration(durationSec)
	if deltaSec <= -60 {
		return fmt.Sprintf("%s · %s(省%d分)", label, durStr, int(math.Round(-deltaSec/60)))
	}
	if deltaSec >= 60 {
		return fmt.Sprintf("%s · %s(慢%d分)", label, durStr, int(math.Round(deltaSec/60)))
	}
	return fmt.Sprintf("%s · %s", label, durStr)
}

func buildBypassHeadline(best BypassOption, origDurationSec float64) string {
	if best.Kind == "official" {
		if best.DurationSeconds > 0 && origDurationSec > 0 && best.DeltaSeconds >= 60 {
			return "周边国道绕行更慢，已保持官方避堵"
		}
		return "官方避堵已是最优，未强行拆段"
	}
	return "推荐: " + best.Summary
}

func formatBypassDuration(sec float64) string {
	mins := int(math.Round(sec / 60))
	if mins < 60 {
		return fmt.Sprintf("%d分", max(1, mins))
	}
	h := mins / 60
	m := mins % 60
	if m == 0 {
		return fmt.Sprintf("%d小时", h)
	}
	return fmt.Sprintf("%d小时%d分", h, m)
}

// searchAmapCorridorTollStations 使用高德 /v3/place/polygon 在高速短走廊内只搜索收费站(180200)。
func (s *Service) searchAmapCorridorTollStations(ctx context.Context, subLine [][]float64) ([]bypassCandidatePOI, error) {
	polygon := buildPolylineCorridorGCJ02(subLine, bypassCorridorHalfW)
	if polygon == "" {
		return nil, nil
	}

	endpoint := "https://restapi.amap.com/v3/place/polygon?" + url.Values{
		"key":     {s.cfg.AmapKey},
		"polygon": {polygon},
		"types":   {"180200"},
		"offset":  {"25"},
		"page":    {"1"},
	}.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("amap polygon search: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("amap polygon status: %d", resp.StatusCode)
	}

	var payload struct {
		Status string `json:"status"`
		Info   string `json:"info"`
		POIs   []struct {
			Name     string `json:"name"`
			Location string `json:"location"`
		} `json:"pois"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode amap polygon: %w", err)
	}
	if payload.Status != "1" {
		return nil, fmt.Errorf("amap polygon error: %s", payload.Info)
	}

	out := make([]bypassCandidatePOI, 0, len(payload.POIs))
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
		wLng, wLat := geo.GCJ02ToWGS84(gLng, gLat)
		out = append(out, bypassCandidatePOI{
			Name: strings.TrimSpace(poi.Name),
			Lng:  roundCoord(wLng),
			Lat:  roundCoord(wLat),
		})
	}
	return out, nil
}

// buildPolylineCorridorGCJ02 将 WGS-84 折线抽稀为最多 6 顶点并左右各外扩 halfWidthM，输出高德 polygon 参数（GCJ-02）。
func buildPolylineCorridorGCJ02(line [][]float64, halfWidthM float64) string {
	sampled := simplifyLineCoords(line, 6)
	if len(sampled) < 2 {
		return ""
	}

	gcj := make([][2]float64, len(sampled))
	for i, p := range sampled {
		gx, gy := geo.WGS84ToGCJ02(p[0], p[1])
		gcj[i] = [2]float64{gx, gy}
	}

	left := make([][2]float64, len(gcj))
	right := make([][2]float64, len(gcj))
	for i := range gcj {
		var dx, dy float64
		switch {
		case i == 0:
			dx = gcj[1][0] - gcj[0][0]
			dy = gcj[1][1] - gcj[0][1]
		case i == len(gcj)-1:
			dx = gcj[i][0] - gcj[i-1][0]
			dy = gcj[i][1] - gcj[i-1][1]
		default:
			dx = gcj[i+1][0] - gcj[i-1][0]
			dy = gcj[i+1][1] - gcj[i-1][1]
		}
		cosLat := math.Max(0.2, math.Cos(gcj[i][1]*math.Pi/180))
		dxM := dx * 111320 * cosLat
		dyM := dy * 110540
		segLen := math.Hypot(dxM, dyM)
		if segLen < 1 {
			left[i] = gcj[i]
			right[i] = gcj[i]
			continue
		}
		nLng := ((-dyM / segLen) * halfWidthM) / (111320 * cosLat)
		nLat := ((dxM / segLen) * halfWidthM) / 110540
		left[i] = [2]float64{gcj[i][0] + nLng, gcj[i][1] + nLat}
		right[i] = [2]float64{gcj[i][0] - nLng, gcj[i][1] - nLat}
	}

	ring := make([]string, 0, len(left)+len(right)+1)
	for _, p := range left {
		ring = append(ring, fmt.Sprintf("%.6f,%.6f", p[0], p[1]))
	}
	for i := len(right) - 1; i >= 0; i-- {
		ring = append(ring, fmt.Sprintf("%.6f,%.6f", right[i][0], right[i][1]))
	}
	ring = append(ring, ring[0])
	return strings.Join(ring, ";")
}

func lineDistanceBetween(line [][]float64, startIdx, endIdx int) float64 {
	if startIdx < 0 {
		startIdx = 0
	}
	if endIdx >= len(line) {
		endIdx = len(line) - 1
	}
	acc := 0.0
	for i := startIdx + 1; i <= endIdx; i++ {
		acc += haversineRouteMeters(line[i-1][0], line[i-1][1], line[i][0], line[i][1])
	}
	return acc
}

// projectPointOntoLine 计算点到折线的最短投影距离，并返回投影点沿折线的累计里程（米）与垂直距离（米）。
func projectPointOntoLine(line [][]float64, cumDist []float64, pt []float64) (float64, float64) {
	bestDist := math.MaxFloat64
	bestAlong := 0.0
	cosLat := math.Max(0.2, math.Cos(pt[1]*math.Pi/180))

	for i := 0; i < len(line)-1; i++ {
		a, b := line[i], line[i+1]
		ax, ay := a[0]*111320*cosLat, a[1]*110540
		bx, by := b[0]*111320*cosLat, b[1]*110540
		px, py := pt[0]*111320*cosLat, pt[1]*110540

		dx, dy := bx-ax, by-ay
		segLenSq := dx*dx + dy*dy
		t := 0.0
		if segLenSq > 1e-6 {
			t = ((px-ax)*dx + (py-ay)*dy) / segLenSq
			if t < 0 {
				t = 0
			} else if t > 1 {
				t = 1
			}
		}
		projX, projY := ax+t*dx, ay+t*dy
		d := math.Hypot(px-projX, py-projY)
		if d < bestDist {
			bestDist = d
			bestAlong = cumDist[i] + t*(cumDist[i+1]-cumDist[i])
		}
	}
	return bestAlong, bestDist
}

func nearestVertexIndex(line [][]float64, pt []float64) int {
	idx, _ := nearestVertexWithDist(line, pt)
	return idx
}

func nearestVertexWithDist(line [][]float64, pt []float64) (int, float64) {
	bestIdx := 0
	bestDist := math.MaxFloat64
	for i, p := range line {
		if len(p) < 2 {
			continue
		}
		d := haversineRouteMeters(p[0], p[1], pt[0], pt[1])
		if d < bestDist {
			bestDist = d
			bestIdx = i
		}
	}
	return bestIdx, bestDist
}

func walkBackAlongLine(line [][]float64, fromIdx int, maxMeters float64) int {
	idx := fromIdx
	acc := 0.0
	for idx > 0 && acc < maxMeters {
		acc += haversineRouteMeters(line[idx][0], line[idx][1], line[idx-1][0], line[idx-1][1])
		idx--
	}
	return idx
}

func walkForwardAlongLine(line [][]float64, fromIdx int, maxMeters float64) int {
	idx := fromIdx
	acc := 0.0
	for idx < len(line)-1 && acc < maxMeters {
		acc += haversineRouteMeters(line[idx][0], line[idx][1], line[idx+1][0], line[idx+1][1])
		idx++
	}
	return idx
}
