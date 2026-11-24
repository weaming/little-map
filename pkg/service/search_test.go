package service

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"little-map/pkg/config"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func jsonResp(body string) *http.Response {
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

func TestSearchAmapPrioritizesViewportAndFallsBack(t *testing.T) {
	bounds := [4]float64{116.35, 39.88, 116.45, 39.95}
	centerLng, centerLat := 116.40, 39.91

	t.Run("viewport polygon full hit skips around and text and keeps same-name branches", func(t *testing.T) {
		svc := &Service{
			cfg: &config.Config{AmapKey: "test-key"},
			httpClient: &http.Client{
				Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
					switch req.URL.Path {
					case "/v3/config/district":
						return jsonResp(`{"status":"1","districts":[]}`), nil
					case "/v5/place/polygon":
						if !strings.Contains(req.URL.Query().Get("polygon"), "|") {
							t.Fatalf("expected v5 polygon separated by '|'")
						}
						if req.URL.Query().Get("show_fields") != "business,photos" {
							t.Fatalf("expected show_fields=business,photos, got %q", req.URL.Query().Get("show_fields"))
						}
						return jsonResp(`{"status":"1","pois":[
							{"id":"B001","name":"瑞幸咖啡","address":"东城区1号","cityname":"北京市","adname":"东城区","location":"116.405,39.915","type":"餐饮;咖啡厅","business":{"tel":"010-12345678","opentime_today":"07:30-21:00","rating":"4.7","cost":"22","business_area":"王府井","tag":"拿铁,美式","alias":"luckin"},"photos":[{"title":"门头","url":"https://img.example.com/1.jpg"}]},
							{"id":"B002","name":"瑞幸咖啡","address":"东城区2号","cityname":"北京市","adname":"东城区","location":"116.415,39.920","type":"餐饮;咖啡厅"}
						]}`), nil
					default:
						t.Fatalf("unexpected endpoint called: %s", req.URL.Path)
						return nil, nil
					}
				}),
			},
		}

		res, provider, err := svc.SearchPlaces(context.Background(), "咖啡", "amap", 2, SearchOptions{
			CenterLng: &centerLng,
			CenterLat: &centerLat,
			Bounds:    &bounds,
		})
		if err != nil {
			t.Fatalf("SearchPlaces error: %v", err)
		}
		if provider != "amap" || len(res) != 2 {
			t.Fatalf("expected both same-name branches kept, provider=%s res=%+v", provider, res)
		}
		if res[0].Tel != "010-12345678" || res[0].OpenTime != "07:30-21:00" || res[0].Rating != "4.7" || res[0].Cost != "22" || res[0].BusinessArea != "王府井" || len(res[0].Tags) != 2 || len(res[0].Photos) != 1 {
			t.Fatalf("expected rich POI details parsed, got %+v", res[0])
		}
	})

	t.Run("sparse polygon supplements from around with deduplication", func(t *testing.T) {
		calledAround := false
		svc := &Service{
			cfg: &config.Config{AmapKey: "test-key"},
			httpClient: &http.Client{
				Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
					switch req.URL.Path {
					case "/v3/config/district":
						return jsonResp(`{"status":"1","districts":[]}`), nil
					case "/v5/place/polygon":
						return jsonResp(`{"status":"1","pois":[{"id":"B001","name":"视口医院","address":"东城区","cityname":"北京市","adname":"东城区","location":"116.40,39.91","type":"医疗"}]}`), nil
					case "/v5/place/around":
						calledAround = true
						return jsonResp(`{"status":"1","pois":[
							{"id":"B001","name":"视口医院","address":"东城区","cityname":"北京市","adname":"东城区","location":"116.40,39.91","type":"医疗"},
							{"id":"B002","name":"附近医院","address":"朝阳路","cityname":"北京市","adname":"朝阳区","location":"116.46,39.92","type":"医疗"}
						]}`), nil
					default:
						t.Fatalf("unexpected endpoint called: %s", req.URL.Path)
						return nil, nil
					}
				}),
			},
		}

		res, _, err := svc.SearchPlaces(context.Background(), "医院", "amap", 5, SearchOptions{
			CenterLng: &centerLng,
			CenterLat: &centerLat,
			Bounds:    &bounds,
		})
		if err != nil {
			t.Fatalf("SearchPlaces error: %v", err)
		}
		if !calledAround || len(res) != 2 || res[0].Name != "视口医院" || res[1].Name != "附近医院" {
			t.Fatalf("expected merged polygon + around, calledAround=%v res=%+v", calledAround, res)
		}
	})

	t.Run("v5 failure degrades to v3 seamlessly", func(t *testing.T) {
		calledV3 := false
		svc := &Service{
			cfg: &config.Config{AmapKey: "test-key"},
			httpClient: &http.Client{
				Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
					switch req.URL.Path {
					case "/v3/config/district":
						return jsonResp(`{"status":"1","districts":[]}`), nil
					case "/v5/place/polygon", "/v5/place/around":
						return jsonResp(`{"status":"0","info":"INSUFFICIENT_PRIVILEGES"}`), nil
					case "/v3/place/polygon":
						calledV3 = true
						return jsonResp(`{"status":"1","pois":[{"id":"V301","name":"旧版咖啡","address":"东城区","cityname":"北京市","adname":"东城区","location":"116.40,39.91","type":"餐饮"}]}`), nil
					case "/v3/place/around":
						return jsonResp(`{"status":"1","pois":[]}`), nil
					default:
						t.Fatalf("unexpected endpoint called: %s", req.URL.Path)
						return nil, nil
					}
				}),
			},
		}

		res, _, err := svc.SearchPlaces(context.Background(), "咖啡", "amap", 5, SearchOptions{
			CenterLng: &centerLng,
			CenterLat: &centerLat,
			Bounds:    &bounds,
		})
		if err != nil {
			t.Fatalf("SearchPlaces error: %v", err)
		}
		if !calledV3 || len(res) != 1 || res[0].Name != "旧版咖啡" {
			t.Fatalf("expected v3 fallback, calledV3=%v res=%+v", calledV3, res)
		}
	})

	t.Run("polygon and around empty falls back to global text", func(t *testing.T) {
		calledText := false
		svc := &Service{
			cfg: &config.Config{AmapKey: "test-key"},
			httpClient: &http.Client{
				Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
					switch req.URL.Path {
					case "/v3/config/district":
						return jsonResp(`{"status":"1","districts":[]}`), nil
					case "/v5/place/polygon", "/v5/place/around":
						return jsonResp(`{"status":"1","pois":[]}`), nil
					case "/v5/place/text":
						calledText = true
						return jsonResp(`{"status":"1","pois":[{"id":"T001","name":"杭州西湖","address":"西湖区","cityname":"杭州市","adname":"西湖区","location":"120.15,30.25","type":"风景名胜"}]}`), nil
					default:
						t.Fatalf("unexpected endpoint called: %s", req.URL.Path)
						return nil, nil
					}
				}),
			},
		}

		res, _, err := svc.SearchPlaces(context.Background(), "杭州西湖", "amap", 8, SearchOptions{
			CenterLng: &centerLng,
			CenterLat: &centerLat,
			Bounds:    &bounds,
		})
		if err != nil {
			t.Fatalf("SearchPlaces error: %v", err)
		}
		if !calledText || len(res) != 1 || res[0].Name != "杭州西湖" {
			t.Fatalf("expected text fallback, calledText=%v res=%+v", calledText, res)
		}
	})

	t.Run("remote district discards unrelated local shops", func(t *testing.T) {
		calledText := false
		svc := &Service{
			cfg: &config.Config{AmapKey: "test-key"},
			httpClient: &http.Client{
				Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
					switch req.URL.Path {
					case "/v3/config/district":
						return jsonResp(`{"status":"1","districts":[{"name":"杭州市","center":"120.155,30.274","level":"city","polyline":"120.10,30.20;120.20,30.20;120.20,30.30;120.10,30.30"}]}`), nil
					case "/v5/place/polygon":
						return jsonResp(`{"status":"1","pois":[{"id":"BJ1","name":"杭州小笼包(北京店)","address":"东城区","cityname":"北京市","adname":"东城区","location":"116.40,39.91","type":"餐饮"}]}`), nil
					case "/v5/place/around":
						return jsonResp(`{"status":"1","pois":[]}`), nil
					case "/v5/place/text":
						calledText = true
						return jsonResp(`{"status":"1","pois":[{"id":"HZ1","name":"杭州东站","address":"上城区","cityname":"杭州市","adname":"上城区","location":"120.21,30.29","type":"交通"}]}`), nil
					default:
						t.Fatalf("unexpected endpoint called: %s", req.URL.Path)
						return nil, nil
					}
				}),
			},
		}

		res, _, err := svc.SearchPlaces(context.Background(), "杭州", "amap", 8, SearchOptions{
			CenterLng: &centerLng,
			CenterLat: &centerLat,
			Bounds:    &bounds,
		})
		if err != nil {
			t.Fatalf("SearchPlaces error: %v", err)
		}
		if !calledText || len(res) != 2 || res[0].Name != "杭州市" || res[1].Name != "杭州东站" {
			t.Fatalf("expected remote district + global text, calledText=%v res=%+v", calledText, res)
		}
	})
}

func TestSearchOSMPassesViewboxAndFiltersOutliers(t *testing.T) {
	bounds := [4]float64{116.35, 39.88, 116.45, 39.95}
	svc := &Service{
		cfg: &config.Config{},
		httpClient: &http.Client{
			Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				vb := req.URL.Query().Get("viewbox")
				if vb != "116.350000,39.950000,116.450000,39.880000" {
					t.Fatalf("unexpected viewbox: %q", vb)
				}
				return jsonResp(`[
					{"name":"Local Cafe","display_name":"Local Cafe, Beijing","lat":"39.91","lon":"116.40","category":"amenity"},
					{"name":"Far Cafe","display_name":"Far Cafe, London","lat":"51.50","lon":"-0.12","category":"amenity"}
				]`), nil
			}),
		},
	}

	res, provider, err := svc.SearchPlaces(context.Background(), "cafe", "osm", 8, SearchOptions{Bounds: &bounds})
	if err != nil {
		t.Fatalf("SearchPlaces error: %v", err)
	}
	if provider != "osm" || len(res) != 1 || res[0].Name != "Local Cafe" {
		t.Fatalf("expected far outlier filtered out, got provider=%s res=%+v", provider, res)
	}
}

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
