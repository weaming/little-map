package api

import (
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"path"
	"strconv"
	"strings"

	"little-map/pkg/service"
	"little-map/pkg/store"

	"github.com/gin-gonic/gin"
)

// NewRouter 构建 Gin Release 模式路由，挂载 REST API、MCP 端点与内嵌前端静态资源。
func NewRouter(svc *service.Service, mcpHandler http.Handler, webFS fs.FS) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())

	group := r.Group("/api")
	{
		group.GET("/health", func(c *gin.Context) {
			c.JSON(http.StatusOK, gin.H{"status": "ok"})
		})
		group.GET("/config", func(c *gin.Context) {
			c.JSON(http.StatusOK, svc.Capabilities())
		})
		group.POST("/maps", handleCreateMap(svc))
		group.POST("/maps/:id/clone", handleCloneMap(svc))
		group.GET("/maps/:id", handleGetMap(svc))
		group.PATCH("/maps/:id", handleUpdateMapMeta(svc))
		group.POST("/maps/:id/features/batch", handleUpsertFeatures(svc))
		group.DELETE("/maps/:id/features", handleDeleteFeatures(svc))
		group.GET("/maps/:id/export.geojson", handleExportGeoJSON(svc))
		group.GET("/search", handleSearch(svc))
		group.GET("/regeo", handleReverseGeocode(svc))
		group.POST("/route", handlePlanRoute(svc))
		group.POST("/route/bypass", handleRouteBypass(svc))
		group.GET("/tile-proxy", handleTileProxy(svc))
		group.GET("/admin/maps", handleAdminListMaps(svc))
		group.DELETE("/admin/maps/:id", handleAdminDeleteMap(svc))
	}

	if mcpHandler != nil {
		r.Any("/mcp", gin.WrapH(mcpHandler))
	}

	if webFS != nil {
		mountStatic(r, webFS)
	}
	return r
}

func handleCreateMap(svc *service.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var in service.CreateMapInput
		if c.Request.ContentLength > 0 {
			if err := c.ShouldBindJSON(&in); err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
				return
			}
		}

		res, err := svc.CreateMap(c.Request.Context(), in)
		if err != nil {
			writeServiceError(c, err)
			return
		}
		c.JSON(http.StatusCreated, res)
	}
}

func handleCloneMap(svc *service.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var body struct {
			Title string `json:"title"`
		}
		if c.Request.ContentLength > 0 {
			if err := c.ShouldBindJSON(&body); err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
				return
			}
		}

		res, err := svc.CloneMap(c.Request.Context(), c.Param("id"), body.Title)
		if err != nil {
			writeServiceError(c, err)
			return
		}
		c.JSON(http.StatusCreated, res)
	}
}

func handleGetMap(svc *service.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		mapID := c.Param("id")
		editToken := extractEditToken(c)

		snap, err := svc.GetMap(c.Request.Context(), mapID, editToken)
		if err != nil {
			writeServiceError(c, err)
			return
		}

		etag := fmt.Sprintf(`"rev-%d-%t"`, snap.Map.Revision, snap.CanEdit)
		c.Header("ETag", etag)
		c.Header("Cache-Control", "no-cache")
		if etagMatches(c.GetHeader("If-None-Match"), etag) {
			c.Status(http.StatusNotModified)
			return
		}

		c.JSON(http.StatusOK, snap)
	}
}

func handleUpdateMapMeta(svc *service.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var body struct {
			BaseRevision int64    `json:"base_revision"`
			Title        *string  `json:"title"`
			Description  *string  `json:"description"`
			CenterLng    *float64 `json:"center_lng"`
			CenterLat    *float64 `json:"center_lat"`
			Zoom         *float64 `json:"zoom"`
			Basemap      *string  `json:"basemap"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}

		updated, err := svc.UpdateMapMeta(c.Request.Context(), c.Param("id"), extractEditToken(c), body.BaseRevision, store.MapPatch{
			Title:       body.Title,
			Description: body.Description,
			CenterLng:   body.CenterLng,
			CenterLat:   body.CenterLat,
			Zoom:        body.Zoom,
			Basemap:     body.Basemap,
		})
		if err != nil {
			writeServiceError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"map": updated})
	}
}

func handleUpsertFeatures(svc *service.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var body struct {
			BaseRevision int64                  `json:"base_revision"`
			Features     []service.FeatureInput `json:"features"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}

		rev, saved, err := svc.UpsertFeatures(c.Request.Context(), c.Param("id"), extractEditToken(c), body.BaseRevision, body.Features)
		if err != nil {
			writeServiceError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"revision": rev,
			"features": saved,
		})
	}
}

func handleDeleteFeatures(svc *service.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var body struct {
			BaseRevision int64    `json:"base_revision"`
			FeatureIDs   []string `json:"feature_ids"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}

		rev, deleted, err := svc.DeleteFeatures(c.Request.Context(), c.Param("id"), extractEditToken(c), body.BaseRevision, body.FeatureIDs)
		if err != nil {
			writeServiceError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"revision": rev,
			"deleted":  deleted,
		})
	}
}

func handleExportGeoJSON(svc *service.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		title, raw, err := svc.ExportGeoJSON(c.Request.Context(), c.Param("id"))
		if err != nil {
			writeServiceError(c, err)
			return
		}

		safeName := strings.ReplaceAll(strings.TrimSpace(title), `"`, "")
		if safeName == "" {
			safeName = c.Param("id")
		}
		c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.geojson"`, safeName))
		c.Data(http.StatusOK, "application/geo+json; charset=utf-8", raw)
	}
}

func handleSearch(svc *service.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		query := c.Query("q")
		provider := c.DefaultQuery("provider", "auto")
		limit, _ := strconv.Atoi(c.DefaultQuery("limit", "20"))

		var opts service.SearchOptions
		if lngStr, latStr := strings.TrimSpace(c.Query("lng")), strings.TrimSpace(c.Query("lat")); lngStr != "" && latStr != "" {
			if lng, err1 := strconv.ParseFloat(lngStr, 64); err1 == nil {
				if lat, err2 := strconv.ParseFloat(latStr, 64); err2 == nil {
					opts.CenterLng = &lng
					opts.CenterLat = &lat
				}
			}
		}
		if boundsStr := strings.TrimSpace(c.Query("bounds")); boundsStr != "" {
			parts := strings.Split(boundsStr, ",")
			if len(parts) == 4 {
				var b [4]float64
				ok := true
				for i, p := range parts {
					v, err := strconv.ParseFloat(strings.TrimSpace(p), 64)
					if err != nil {
						ok = false
						break
					}
					b[i] = v
				}
				if ok {
					opts.Bounds = &b
				}
			}
		}

		results, usedProvider, err := svc.SearchPlaces(c.Request.Context(), query, provider, limit, opts)
		if err != nil {
			writeServiceError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"provider": usedProvider,
			"results":  results,
		})
	}
}

func handleReverseGeocode(svc *service.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		lng, errLng := strconv.ParseFloat(c.Query("lng"), 64)
		lat, errLat := strconv.ParseFloat(c.Query("lat"), 64)
		if errLng != nil || errLat != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid lng/lat parameters"})
			return
		}

		res, err := svc.ReverseGeocode(c.Request.Context(), lng, lat)
		if err != nil {
			writeServiceError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"result": res})
	}
}

func handlePlanRoute(svc *service.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var in service.RouteInput
		if err := c.ShouldBindJSON(&in); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		res, err := svc.PlanRoute(c.Request.Context(), in)
		if err != nil {
			writeServiceError(c, err)
			return
		}
		c.JSON(http.StatusOK, res)
	}
}

func handleRouteBypass(svc *service.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var in service.BypassInput
		if err := c.ShouldBindJSON(&in); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		res, err := svc.FindHighwayBypassAnchors(c.Request.Context(), in)
		if err != nil {
			writeServiceError(c, err)
			return
		}
		c.JSON(http.StatusOK, res)
	}
}

func handleTileProxy(svc *service.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		provider := c.Query("provider")
		z, errZ := strconv.Atoi(c.Query("z"))
		x, errX := strconv.Atoi(c.Query("x"))
		y, errY := strconv.Atoi(c.Query("y"))
		if errZ != nil || errX != nil || errY != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid z/x/y parameters"})
			return
		}

		data, contentType, err := svc.FetchOverlayTile(c.Request.Context(), provider, z, x, y)
		if err != nil {
			writeServiceError(c, err)
			return
		}
		if provider == "amap-traffic" {
			c.Header("Cache-Control", "public, max-age=120")
		} else {
			c.Header("Cache-Control", "public, max-age=86400")
		}
		c.Data(http.StatusOK, contentType, data)
	}
}

func handleAdminListMaps(svc *service.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !svc.VerifyAdminKey(strings.TrimSpace(c.GetHeader("X-Admin-Key"))) {
			c.JSON(http.StatusForbidden, gin.H{"error": "invalid or missing admin key"})
			return
		}
		list, err := svc.ListMaps(c.Request.Context())
		if err != nil {
			writeServiceError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"maps": list})
	}
}

func handleAdminDeleteMap(svc *service.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !svc.VerifyAdminKey(strings.TrimSpace(c.GetHeader("X-Admin-Key"))) {
			c.JSON(http.StatusForbidden, gin.H{"error": "invalid or missing admin key"})
			return
		}
		if err := svc.DeleteMap(c.Request.Context(), c.Param("id")); err != nil {
			writeServiceError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"deleted": true})
	}
}

func extractEditToken(c *gin.Context) string {
	if token := strings.TrimSpace(c.GetHeader("X-Edit-Token")); token != "" {
		return token
	}
	return strings.TrimSpace(c.Query("t"))
}

// etagMatches 兼容反向代理开启压缩后将强 ETag 改写为弱 ETag（W/"..."）的场景。
func etagMatches(ifNoneMatch, etag string) bool {
	if ifNoneMatch == "" {
		return false
	}
	for _, part := range strings.Split(ifNoneMatch, ",") {
		candidate := strings.TrimSpace(part)
		candidate = strings.TrimPrefix(candidate, "W/")
		if candidate == etag {
			return true
		}
	}
	return false
}

func writeServiceError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "map not found"})
	case errors.Is(err, store.ErrForbidden):
		c.JSON(http.StatusForbidden, gin.H{"error": "invalid or missing edit token"})
	case errors.Is(err, store.ErrRevisionConflict):
		c.JSON(http.StatusConflict, gin.H{"error": "map was updated by someone else; please refresh"})
	case errors.Is(err, service.ErrInvalidInput):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
	}
}

func mountStatic(r *gin.Engine, webFS fs.FS) {
	fileServer := http.FileServer(http.FS(webFS))
	r.NoRoute(func(c *gin.Context) {
		if strings.HasPrefix(c.Request.URL.Path, "/api/") || c.Request.URL.Path == "/mcp" {
			c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
			return
		}

		cleanPath := strings.TrimPrefix(path.Clean(c.Request.URL.Path), "/")
		if cleanPath == "" || cleanPath == "." {
			cleanPath = "index.html"
		}

		if f, err := webFS.Open(cleanPath); err == nil {
			_ = f.Close()
			fileServer.ServeHTTP(c.Writer, c.Request)
			return
		}

		indexBytes, err := fs.ReadFile(webFS, "index.html")
		if err != nil {
			c.String(http.StatusNotFound, "frontend bundle missing")
			return
		}
		c.Data(http.StatusOK, "text/html; charset=utf-8", indexBytes)
	})
}
