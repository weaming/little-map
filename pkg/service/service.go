package service

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"little-map/pkg/config"
	"little-map/pkg/geo"
	"little-map/pkg/store"
)

var ErrInvalidInput = errors.New("invalid input")

// Service 聚合地图、标注与搜索的核心业务逻辑，供 REST API 与 MCP 共用。
type Service struct {
	store      *store.Store
	cfg        *config.Config
	httpClient *http.Client
}

// New 创建业务服务实例。
func New(st *store.Store, cfg *config.Config) *Service {
	return &Service{
		store:      st,
		cfg:        cfg,
		httpClient: cfg.NewHTTPClient(10 * time.Second),
	}
}

// CreateMapInput 定义创建地图的入参。
type CreateMapInput struct {
	Title       string  `json:"title"`
	Description string  `json:"description"`
	CenterLng   float64 `json:"center_lng"`
	CenterLat   float64 `json:"center_lat"`
	Zoom        float64 `json:"zoom"`
	Basemap     string  `json:"basemap"`
}

// CreateMapResult 返回新地图元信息与编辑令牌。
type CreateMapResult struct {
	Map       *store.Map `json:"map"`
	EditToken string     `json:"edit_token"`
}

// MapSnapshot 表示地图与标注的完整快照。
type MapSnapshot struct {
	Map      *store.Map      `json:"map"`
	Features []store.Feature `json:"features"`
	CanEdit  bool            `json:"can_edit"`
}

// FeatureInput 定义新增或更新单个标注的入参。
type FeatureInput struct {
	ID          string       `json:"id"`
	Title       string       `json:"title"`
	Description string       `json:"description"`
	Category    string       `json:"category"`
	Color       string       `json:"color"`
	Icon        string       `json:"icon"`
	Geometry    geo.Geometry `json:"geometry"`
	Visible     *bool        `json:"visible"`
	SortOrder   int          `json:"sort_order"`
}

// CreateMap 创建一张免登录可分享地图。
func (s *Service) CreateMap(ctx context.Context, in CreateMapInput) (*CreateMapResult, error) {
	title := strings.TrimSpace(in.Title)
	if title == "" {
		title = "未命名地图"
	}
	if in.CenterLng == 0 && in.CenterLat == 0 {
		in.CenterLng = 116.3974
		in.CenterLat = 39.9093
	}
	if in.Zoom <= 0 || in.Zoom > 22 {
		in.Zoom = 11
	}
	basemap := strings.TrimSpace(in.Basemap)
	if basemap == "" {
		basemap = s.cfg.DefaultBasemap
	}

	mapID, err := randomToken(8)
	if err != nil {
		return nil, fmt.Errorf("generate map id: %w", err)
	}
	editToken, err := randomToken(18)
	if err != nil {
		return nil, fmt.Errorf("generate edit token: %w", err)
	}

	created, err := s.store.CreateMap(ctx, store.Map{
		ID:          mapID,
		EditToken:   editToken,
		Title:       title,
		Description: strings.TrimSpace(in.Description),
		CenterLng:   in.CenterLng,
		CenterLat:   in.CenterLat,
		Zoom:        in.Zoom,
		Basemap:     basemap,
	})
	if err != nil {
		return nil, err
	}

	return &CreateMapResult{
		Map:       created,
		EditToken: editToken,
	}, nil
}

// GetMap 获取地图快照并判断是否拥有编辑权限。
func (s *Service) GetMap(ctx context.Context, mapID, editToken string) (*MapSnapshot, error) {
	m, features, err := s.store.GetMap(ctx, mapID)
	if err != nil {
		return nil, err
	}
	canEdit := editToken != "" && editToken == m.EditToken
	return &MapSnapshot{
		Map:      m,
		Features: features,
		CanEdit:  canEdit,
	}, nil
}

// UpdateMapMeta 更新地图标题、描述、视角或默认底图。
func (s *Service) UpdateMapMeta(ctx context.Context, mapID, editToken string, baseRevision int64, patch store.MapPatch) (*store.Map, error) {
	if patch.Title != nil {
		trimmed := strings.TrimSpace(*patch.Title)
		if trimmed == "" {
			return nil, fmt.Errorf("%w: title cannot be empty", ErrInvalidInput)
		}
		patch.Title = &trimmed
	}
	return s.store.UpdateMapMeta(ctx, mapID, editToken, baseRevision, patch)
}

// UpsertFeatures 校验并批量写入 WGS-84 标注要素。
func (s *Service) UpsertFeatures(ctx context.Context, mapID, editToken string, baseRevision int64, inputs []FeatureInput) (int64, []store.Feature, error) {
	if len(inputs) == 0 {
		return 0, nil, fmt.Errorf("%w: features list cannot be empty", ErrInvalidInput)
	}

	items := make([]store.Feature, 0, len(inputs))
	for i, in := range inputs {
		if err := geo.ValidateGeometry(in.Geometry); err != nil {
			return 0, nil, fmt.Errorf("%w: feature[%d]: %v", ErrInvalidInput, i, err)
		}

		id := strings.TrimSpace(in.ID)
		if id == "" {
			genID, err := randomToken(9)
			if err != nil {
				return 0, nil, fmt.Errorf("generate feature id: %w", err)
			}
			id = "f_" + genID
		}

		color := strings.TrimSpace(in.Color)
		if color == "" {
			color = "#2563eb"
		}
		icon := strings.TrimSpace(in.Icon)
		if icon == "" {
			icon = "pin"
		}
		visible := true
		if in.Visible != nil {
			visible = *in.Visible
		}

		items = append(items, store.Feature{
			ID:          id,
			MapID:       mapID,
			Title:       strings.TrimSpace(in.Title),
			Description: in.Description,
			Category:    strings.TrimSpace(in.Category),
			Color:       color,
			Icon:        icon,
			Geometry:    in.Geometry,
			Visible:     visible,
			SortOrder:   in.SortOrder,
		})
	}

	return s.store.UpsertFeatures(ctx, mapID, editToken, baseRevision, items)
}

// DeleteFeatures 批量删除地图标注。
func (s *Service) DeleteFeatures(ctx context.Context, mapID, editToken string, baseRevision int64, featureIDs []string) (int64, int64, error) {
	if len(featureIDs) == 0 {
		return 0, 0, fmt.Errorf("%w: feature_ids cannot be empty", ErrInvalidInput)
	}
	return s.store.DeleteFeatures(ctx, mapID, editToken, baseRevision, featureIDs)
}

// ExportGeoJSON 将地图导出为标准 RFC 7946 GeoJSON FeatureCollection。
func (s *Service) ExportGeoJSON(ctx context.Context, mapID string) (string, []byte, error) {
	m, features, err := s.store.GetMap(ctx, mapID)
	if err != nil {
		return "", nil, err
	}

	fcFeatures := make([]map[string]any, 0, len(features))
	for _, f := range features {
		fcFeatures = append(fcFeatures, map[string]any{
			"type":     "Feature",
			"id":       f.ID,
			"geometry": f.Geometry,
			"properties": map[string]any{
				"title":       f.Title,
				"description": f.Description,
				"category":    f.Category,
				"color":       f.Color,
				"icon":        f.Icon,
				"visible":     f.Visible,
				"sort_order":  f.SortOrder,
				"created_at":  f.CreatedAt,
				"updated_at":  f.UpdatedAt,
			},
		})
	}

	payload := map[string]any{
		"type": "FeatureCollection",
		"metadata": map[string]any{
			"map_id":      m.ID,
			"title":       m.Title,
			"description": m.Description,
			"revision":    m.Revision,
			"crs":         "WGS-84",
		},
		"features": fcFeatures,
	}

	raw, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return "", nil, fmt.Errorf("marshal geojson: %w", err)
	}
	return m.Title, raw, nil
}

// Capabilities 返回前端所需的后端可用能力描述。
func (s *Service) Capabilities() map[string]any {
	providers := []string{"osm"}
	if s.cfg.AmapKey != "" {
		providers = append([]string{"amap"}, providers...)
	}
	if s.cfg.GoogleMapsKey != "" {
		providers = append(providers, "google")
	}
	return map[string]any{
		"default_basemap":  s.cfg.DefaultBasemap,
		"search_providers": providers,
		"has_amap_key":     s.cfg.AmapKey != "",
		"has_google_key":   s.cfg.GoogleMapsKey != "",
	}
}

func randomToken(byteLen int) (string, error) {
	buf := make([]byte, byteLen)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
