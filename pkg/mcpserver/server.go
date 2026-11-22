package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"little-map/pkg/config"
	"little-map/pkg/geo"
	"little-map/pkg/service"
	"little-map/pkg/store"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// NewHandler 创建挂载于 /mcp 的 Streamable HTTP MCP 处理器（无状态 JSON 模式，兼容 HTTP/3）。
func NewHandler(svc *service.Service, cfg *config.Config) http.Handler {
	server := mcp.NewServer(&mcp.Implementation{
		Name:    "little-map",
		Version: "1.0.0",
	}, nil)

	registerTools(server, svc, cfg)

	return mcp.NewStreamableHTTPHandler(func(_ *http.Request) *mcp.Server {
		return server
	}, &mcp.StreamableHTTPOptions{
		Stateless:                  true,
		JSONResponse:               true,
		DisableLocalhostProtection: true,
	})
}

type createMapArgs struct {
	Title       string  `json:"title" jsonschema:"Map title"`
	Description string  `json:"description,omitempty" jsonschema:"Optional map description"`
	CenterLng   float64 `json:"center_lng,omitempty" jsonschema:"Initial center longitude (WGS-84)"`
	CenterLat   float64 `json:"center_lat,omitempty" jsonschema:"Initial center latitude (WGS-84)"`
	Zoom        float64 `json:"zoom,omitempty" jsonschema:"Initial zoom level (1-20)"`
	Basemap     string  `json:"basemap,omitempty" jsonschema:"Basemap id: amap-vec, amap-sat, google-vec, google-sat, osm"`
}

type createMapOut struct {
	MapID     string `json:"map_id"`
	EditToken string `json:"edit_token"`
	ViewURL   string `json:"view_url"`
	EditURL   string `json:"edit_url"`
	Revision  int64  `json:"revision"`
}

type getMapArgs struct {
	MapID string `json:"map_id" jsonschema:"Target map ID"`
}

type getMapOut struct {
	Map      *store.Map      `json:"map"`
	Features []store.Feature `json:"features"`
}

type upsertFeaturesArgs struct {
	MapID        string            `json:"map_id" jsonschema:"Target map ID"`
	EditToken    string            `json:"edit_token" jsonschema:"Edit token for write permission"`
	BaseRevision int64             `json:"base_revision,omitempty" jsonschema:"Optional expected revision for optimistic locking"`
	Features     []mcpFeatureInput `json:"features" jsonschema:"List of WGS-84 GeoJSON features to create or update"`
}

type mcpFeatureInput struct {
	ID          string       `json:"id,omitempty" jsonschema:"Optional feature ID; leave empty to create a new feature"`
	Title       string       `json:"title" jsonschema:"Feature title"`
	Description string       `json:"description,omitempty" jsonschema:"Markdown description (supports external image URLs)"`
	Category    string       `json:"category,omitempty" jsonschema:"Optional group or category tag"`
	Color       string       `json:"color,omitempty" jsonschema:"Hex color such as #2563eb"`
	Icon        string       `json:"icon,omitempty" jsonschema:"Marker icon name: pin, star, food, hotel, transit, flag"`
	Geometry    geo.Geometry `json:"geometry" jsonschema:"WGS-84 GeoJSON geometry (Point, LineString, or Polygon)"`
	Visible     *bool        `json:"visible,omitempty" jsonschema:"Whether feature is visible on map"`
}

type upsertFeaturesOut struct {
	Revision int64           `json:"revision"`
	Features []store.Feature `json:"features"`
}

type deleteFeaturesArgs struct {
	MapID        string   `json:"map_id" jsonschema:"Target map ID"`
	EditToken    string   `json:"edit_token" jsonschema:"Edit token for write permission"`
	BaseRevision int64    `json:"base_revision,omitempty" jsonschema:"Optional expected revision for optimistic locking"`
	FeatureIDs   []string `json:"feature_ids" jsonschema:"List of feature IDs to delete"`
}

type deleteFeaturesOut struct {
	Revision int64 `json:"revision"`
	Deleted  int64 `json:"deleted"`
}

type searchPlaceArgs struct {
	Query    string `json:"query" jsonschema:"Place name or address to search"`
	Provider string `json:"provider,omitempty" jsonschema:"Provider: auto, amap, google, or osm"`
	Limit    int    `json:"limit,omitempty" jsonschema:"Maximum number of results (1-20)"`
}

type searchPlaceOut struct {
	Provider string                `json:"provider"`
	Results  []service.PlaceResult `json:"results"`
}

type planRouteArgs struct {
	Mode      string      `json:"mode,omitempty" jsonschema:"Route mode: bicycling or walking (default bicycling)"`
	Waypoints [][]float64 `json:"waypoints" jsonschema:"Ordered list of [lng, lat] WGS-84 waypoints (at least 2)"`
	Provider  string      `json:"provider,omitempty" jsonschema:"Provider: auto, amap, or osrm"`
}

func registerTools(server *mcp.Server, svc *service.Service, cfg *config.Config) {
	mcp.AddTool(server, &mcp.Tool{
		Name:        "create_map",
		Description: "Create a new collaborative map and return its map_id, edit_token, and share links.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, args createMapArgs) (*mcp.CallToolResult, createMapOut, error) {
		res, err := svc.CreateMap(ctx, service.CreateMapInput{
			Title:       args.Title,
			Description: args.Description,
			CenterLng:   args.CenterLng,
			CenterLat:   args.CenterLat,
			Zoom:        args.Zoom,
			Basemap:     args.Basemap,
		})
		if err != nil {
			return nil, createMapOut{}, err
		}

		prefix := cfg.BaseURL
		viewURL := fmt.Sprintf("%s/?m=%s", prefix, res.Map.ID)
		editURL := fmt.Sprintf("%s/?m=%s&t=%s", prefix, res.Map.ID, res.EditToken)
		out := createMapOut{
			MapID:     res.Map.ID,
			EditToken: res.EditToken,
			ViewURL:   viewURL,
			EditURL:   editURL,
			Revision:  res.Map.Revision,
		}
		return jsonTextResult(out), out, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "get_map",
		Description: "Get map metadata and all WGS-84 GeoJSON annotations for a given map_id.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, args getMapArgs) (*mcp.CallToolResult, getMapOut, error) {
		snap, err := svc.GetMap(ctx, strings.TrimSpace(args.MapID), "")
		if err != nil {
			return nil, getMapOut{}, err
		}
		out := getMapOut{
			Map:      snap.Map,
			Features: snap.Features,
		}
		return jsonTextResult(out), out, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "upsert_features",
		Description: "Create or update one or more WGS-84 GeoJSON annotations (Point, LineString, Polygon) on a map.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, args upsertFeaturesArgs) (*mcp.CallToolResult, upsertFeaturesOut, error) {
		inputs := make([]service.FeatureInput, 0, len(args.Features))
		for _, f := range args.Features {
			inputs = append(inputs, service.FeatureInput{
				ID:          f.ID,
				Title:       f.Title,
				Description: f.Description,
				Category:    f.Category,
				Color:       f.Color,
				Icon:        f.Icon,
				Geometry:    f.Geometry,
				Visible:     f.Visible,
			})
		}

		rev, saved, err := svc.UpsertFeatures(ctx, strings.TrimSpace(args.MapID), strings.TrimSpace(args.EditToken), args.BaseRevision, inputs)
		if err != nil {
			return nil, upsertFeaturesOut{}, err
		}
		out := upsertFeaturesOut{
			Revision: rev,
			Features: saved,
		}
		return jsonTextResult(out), out, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "delete_features",
		Description: "Delete annotations by feature_ids from a map.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, args deleteFeaturesArgs) (*mcp.CallToolResult, deleteFeaturesOut, error) {
		rev, deleted, err := svc.DeleteFeatures(ctx, strings.TrimSpace(args.MapID), strings.TrimSpace(args.EditToken), args.BaseRevision, args.FeatureIDs)
		if err != nil {
			return nil, deleteFeaturesOut{}, err
		}
		out := deleteFeaturesOut{
			Revision: rev,
			Deleted:  deleted,
		}
		return jsonTextResult(out), out, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "search_place",
		Description: "Search for a place or POI and return WGS-84 coordinates (lng, lat).",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, args searchPlaceArgs) (*mcp.CallToolResult, searchPlaceOut, error) {
		results, provider, err := svc.SearchPlaces(ctx, args.Query, args.Provider, args.Limit)
		if err != nil {
			return nil, searchPlaceOut{}, err
		}
		out := searchPlaceOut{
			Provider: provider,
			Results:  results,
		}
		return jsonTextResult(out), out, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "plan_route",
		Description: "Plan a bicycling or walking route through WGS-84 waypoints and return distance, duration, and a WGS-84 LineString geometry.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, args planRouteArgs) (*mcp.CallToolResult, *service.RouteResult, error) {
		res, err := svc.PlanRoute(ctx, service.RouteInput{
			Mode:      args.Mode,
			Waypoints: args.Waypoints,
			Provider:  args.Provider,
		})
		if err != nil {
			return nil, nil, err
		}
		return jsonTextResult(res), res, nil
	})
}

func jsonTextResult(v any) *mcp.CallToolResult {
	raw, _ := json.Marshal(v)
	return &mcp.CallToolResult{
		Content: []mcp.Content{
			&mcp.TextContent{Text: string(raw)},
		},
	}
}
