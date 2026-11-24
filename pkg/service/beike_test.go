package service

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"

	"beike-mcp/beike"
)

func TestBeikeSearchPaginationOffsets(t *testing.T) {
	var mu sync.Mutex
	var offsets []int

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		off, _ := strconv.Atoi(r.URL.Query().Get("offset"))
		mu.Lock()
		offsets = append(offsets, off)
		mu.Unlock()

		resp := map[string]any{
			"status": 0,
			"data": map[string]any{
				"total": 200,
				"list": []map[string]any{
					{
						"house_code":           "H_" + strconv.Itoa(off),
						"house_title":          "测试房源",
						"rent_price":           "4000",
						"rent_price_unit":      "元/月",
						"geolatitudelongitude": "39.914889,116.403874",
						"resblock_name":        "测试小区",
					},
				},
			},
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	client := beike.NewClient()
	client.BaseURL = srv.URL
	client.Cache = nil
	svc := &Service{beikeClient: client, beikeSem: make(chan struct{}, 1)}
	svc.beikeOnce.Do(func() {})

	page1, err := svc.SearchBeikeRent(context.Background(), BeikeSearchInput{
		City:      "110000",
		Pages:     2,
		StartPage: 1,
	})
	if err != nil {
		t.Fatalf("page1 search failed: %v", err)
	}
	if page1.NextPage != 3 || page1.RemainingPages <= 0 {
		t.Fatalf("expected next_page=3 with remaining pages, got next=%d rem=%d", page1.NextPage, page1.RemainingPages)
	}

	page2, err := svc.SearchBeikeRent(context.Background(), BeikeSearchInput{
		City:      "110000",
		Pages:     2,
		StartPage: page1.NextPage,
	})
	if err != nil {
		t.Fatalf("page2 search failed: %v", err)
	}
	if page2.NextPage != 5 || len(page2.Houses) != 2 {
		t.Fatalf("expected next_page=5 and 2 houses, got next=%d len=%d", page2.NextPage, len(page2.Houses))
	}

	seen := map[int]bool{}
	for _, o := range offsets {
		seen[o] = true
	}
	for _, want := range []int{0, 30, 60, 90} {
		if !seen[want] {
			t.Fatalf("expected offset %d requested, got offsets=%v", want, offsets)
		}
	}
}
