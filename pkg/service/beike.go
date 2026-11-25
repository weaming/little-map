package service

import (
	"context"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"beike-mcp/beike"

	"little-map/pkg/geo"
)

// BeikeSearchInput 定义贝壳租房搜索参数。
type BeikeSearchInput struct {
	City      string   `json:"city"`
	PriceMin  int      `json:"price_min"`
	PriceMax  int      `json:"price_max"`
	Rooms     int      `json:"rooms"`
	RentType  string   `json:"rent_type"` // any | whole | shared
	District  string   `json:"district"`
	Region    string   `json:"region"`
	MetroLine string   `json:"metro_line"`
	Area      string   `json:"area"`
	MoveIn    string   `json:"move_in"`
	Floor     string   `json:"floor"`
	Brand     string   `json:"brand"`
	Features  []string `json:"features"`
	Sort      string   `json:"sort"`
	Pages     int      `json:"pages"`
	StartPage int      `json:"start_page"` // 1 起，内部转为 0 起
	NoCache   bool     `json:"no_cache"`
}

// BeikeHouse 表示统一转换为 WGS-84 坐标的贝壳租房房源。
type BeikeHouse struct {
	HouseCode   string   `json:"house_code"`
	Title       string   `json:"title"`
	Price       float64  `json:"price"`
	PriceText   string   `json:"price_text"`
	PriceUnit   string   `json:"price_unit"`
	Lng         float64  `json:"lng"`
	Lat         float64  `json:"lat"`
	Layout      string   `json:"layout"`
	Area        float64  `json:"area"`
	Bedrooms    int      `json:"bedrooms"`
	Bathrooms   int      `json:"bathrooms"`
	Orientation string   `json:"orientation"`
	FloorLevel  string   `json:"floor_level,omitempty"`
	FloorTotal  int      `json:"floor_total"`
	District    string   `json:"district"`
	Bizcircle   string   `json:"bizcircle"`
	Resblock    string   `json:"resblock"`
	SubwayDesc  string   `json:"subway_desc"`
	SubwayName  string   `json:"subway_name"`
	RentType    string   `json:"rent_type"` // whole | shared | other
	Tags        []string `json:"tags"`
	Highlights  string   `json:"highlights,omitempty"`
	PriceNote   string   `json:"price_note,omitempty"`
	ListedAt    string   `json:"listed_at,omitempty"`
	AvailableAt string   `json:"available_at,omitempty"`
	PicURL      string   `json:"pic_url,omitempty"`
	PicThumbURL string   `json:"pic_thumb_url,omitempty"`
}

// BeikeSearchResult 汇总贝壳租房查询结果与分页元数据。
type BeikeSearchResult struct {
	CityID         string       `json:"city_id"`
	Total          int          `json:"total"`
	Count          int          `json:"count"`
	Scanned        int          `json:"scanned"`
	Unique         int          `json:"unique"`
	Requests       int          `json:"requests"`
	Partial        bool         `json:"partial"`
	NextPage       int          `json:"next_page,omitempty"`
	RemainingPages int          `json:"remaining_pages,omitempty"`
	Notes          []string     `json:"notes,omitempty"`
	Houses         []BeikeHouse `json:"houses"`
}

func (s *Service) getBeikeClient() *beike.Client {
	s.beikeOnce.Do(func() {
		s.beikeClient = beike.NewClient()
	})
	return s.beikeClient
}

// ListBeikeCities 列出贝壳内置支持租房的城市。
func (s *Service) ListBeikeCities(keyword string) []beike.City {
	return beike.SearchCities(keyword)
}

// ListBeikeRegions 列出指定城市的区域/商圈或地铁线 token。
func (s *Service) ListBeikeRegions(city, kind, keyword string) ([]beike.Region, string, error) {
	cityID, err := beike.ResolveCity(city)
	if err != nil {
		return nil, "", fmt.Errorf("%w: %v", ErrInvalidInput, err)
	}
	if strings.EqualFold(strings.TrimSpace(kind), "metro") {
		return beike.SearchMetros(cityID, keyword), cityID, nil
	}
	return beike.SearchRegions(cityID, keyword), cityID, nil
}

// SearchBeikeRent 调用贝壳匿名租房列表接口，并将小区坐标从 BD-09 统一转换为 WGS-84。
func (s *Service) SearchBeikeRent(ctx context.Context, in BeikeSearchInput) (*BeikeSearchResult, error) {
	cityID, err := beike.ResolveCity(in.City)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidInput, err)
	}

	rentToken := ""
	switch strings.ToLower(strings.TrimSpace(in.RentType)) {
	case "whole", beike.RentTypeWhole:
		rentToken = beike.RentTypeWhole
	case "shared", beike.RentTypeShared:
		rentToken = beike.RentTypeShared
	}

	pages := in.Pages
	if pages <= 0 {
		pages = 5
	} else if pages > 10 {
		pages = 10
	}

	// 贝壳单 IP 并发上限为 2，服务层加闸门避免多标签页同时并发触发空页限流
	if s.beikeSem != nil {
		select {
		case s.beikeSem <- struct{}{}:
			defer func() { <-s.beikeSem }()
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}

	startPage := 0
	if in.StartPage > 1 {
		startPage = in.StartPage - 1
	}

	res, err := s.getBeikeClient().SearchRent(ctx, beike.RentQuery{
		CityID:    cityID,
		PriceMin:  in.PriceMin,
		PriceMax:  in.PriceMax,
		Rooms:     in.Rooms,
		RentType:  rentToken,
		District:  strings.TrimSpace(in.District),
		Region:    strings.TrimSpace(in.Region),
		MetroLine: strings.TrimSpace(in.MetroLine),
		Area:      strings.TrimSpace(in.Area),
		MoveIn:    strings.TrimSpace(in.MoveIn),
		Floor:     strings.TrimSpace(in.Floor),
		Brand:     strings.TrimSpace(in.Brand),
		Features:  in.Features,
		Sort:      strings.TrimSpace(in.Sort),
		Pages:     pages,
		StartPage: startPage,
		NoCache:   in.NoCache,
	})
	if err != nil {
		return nil, fmt.Errorf("beike search: %w", err)
	}

	loc := time.FixedZone("HKT", 8*3600)
	if s.cfg != nil && strings.TrimSpace(s.cfg.TZ) != "" {
		if loaded, err := time.LoadLocation(strings.TrimSpace(s.cfg.TZ)); err == nil {
			loc = loaded
		}
	}

	houses := make([]BeikeHouse, 0, len(res.Houses))
	for _, h := range res.Houses {
		if h.Lng == 0 && h.Lat == 0 {
			continue
		}
		// 贝壳/链家小区坐标为 BD-09，统一转为 WGS-84 供全站底图纠偏渲染
		wLng, wLat := geo.BD09ToWGS84(h.Lng, h.Lat)
		tags := make([]string, 0, len(h.Tags))
		for _, t := range h.Tags {
			if name := strings.TrimSpace(t.Name); name != "" {
				tags = append(tags, name)
			}
		}
		rt := "other"
		switch h.RentType {
		case 200600000001:
			rt = "whole"
		case 200600000002:
			rt = "shared"
		}
		priceText := strings.TrimSpace(h.PriceText)
		if priceText == "" && h.Price > 0 {
			priceText = fmt.Sprintf("%.0f", h.Price)
		}
		raw := h.Raw()
		floorLevel := parseBeikeFloorLevel(raw["floor_level"])
		highlights := asTrimmedString(raw["big_c_recommend_desc"])
		if highlights == "" {
			highlights = asTrimmedString(raw["hot_desc"])
		}
		priceNote := asTrimmedString(raw["operation_desc"])
		listedAt := formatUnixDate(raw["app_plat_ctime"], false, loc)
		availableAt := formatUnixDate(raw["available_rent_time"], true, loc)
		if availableAt == "" {
			availableAt = formatUnixDate(raw["availableRentTime"], true, loc)
		}
		houses = append(houses, BeikeHouse{
			HouseCode:   h.HouseCode,
			Title:       h.Title,
			Price:       h.Price,
			PriceText:   priceText,
			PriceUnit:   h.PriceUnit,
			Lng:         roundCoord(wLng),
			Lat:         roundCoord(wLat),
			Layout:      h.Layout,
			Area:        h.Area,
			Bedrooms:    h.Bedrooms,
			Bathrooms:   h.Bathrooms,
			Orientation: h.Orientation,
			FloorLevel:  floorLevel,
			FloorTotal:  h.FloorTotal,
			District:    h.District,
			Bizcircle:   h.Bizcircle,
			Resblock:    h.Resblock,
			SubwayDesc:  h.SubwayDesc,
			SubwayName:  h.SubwayName,
			RentType:    rt,
			Tags:        tags,
			Highlights:  highlights,
			PriceNote:   priceNote,
			ListedAt:    listedAt,
			AvailableAt: availableAt,
			PicURL:      beike.PicURL(h.PicURL, "large"),
			PicThumbURL: beike.PicURL(h.PicURL, "small"),
		})
	}

	nextPage := 0
	if res.NextPage > 0 && res.RemainingPages > 0 {
		nextPage = res.NextPage + 1
	}

	return &BeikeSearchResult{
		CityID:         cityID,
		Total:          res.Total,
		Count:          len(houses),
		Scanned:        res.Scanned,
		Unique:         res.Unique,
		Requests:       res.Requests,
		Partial:        res.Partial,
		NextPage:       nextPage,
		RemainingPages: res.RemainingPages,
		Notes:          res.Notes,
		Houses:         houses,
	}, nil
}

func parseBeikeFloorLevel(v any) string {
	switch asTrimmedString(v) {
	case "200500000001":
		return "高楼层"
	case "200500000002":
		return "中楼层"
	case "200500000003":
		return "低楼层"
	default:
		return ""
	}
}

func formatUnixDate(v any, isMillis bool, loc *time.Location) string {
	var num float64
	switch val := v.(type) {
	case float64:
		num = val
	case int64:
		num = float64(val)
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(val), 64)
		if err != nil {
			return ""
		}
		num = parsed
	default:
		return ""
	}
	if math.IsNaN(num) || math.IsInf(num, 0) || num <= 0 {
		return ""
	}
	sec := int64(num)
	if isMillis || num > 1e11 {
		sec = int64(num / 1000)
	}
	// 忽略 2000 年前的占位时间戳
	if sec < 946684800 {
		return ""
	}
	return time.Unix(sec, 0).In(loc).Format("2006-01-02")
}
