package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"little-map/pkg/api"
	"little-map/pkg/config"
	"little-map/pkg/mcpserver"
	"little-map/pkg/service"
	"little-map/pkg/store"
)

func setupTestRouter(t *testing.T) http.Handler {
	t.Helper()
	st, err := store.Open(":memory:", time.FixedZone("HKT", 8*3600))
	if err != nil {
		t.Fatalf("open memory store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	cfg := &config.Config{
		DefaultBasemap: "amap-vec",
		BaseURL:        "https://map.example.com",
		AdminKey:       "secret-admin-key",
	}
	svc := service.New(st, cfg)
	mcpHandler := mcpserver.NewHandler(svc, cfg)
	return api.NewRouter(svc, mcpHandler, nil)
}

func TestMapCRUDOptimisticLockAndETag(t *testing.T) {
	router := setupTestRouter(t)

	// 1. 创建地图
	createReq := httptest.NewRequest(http.MethodPost, "/api/maps", bytes.NewBufferString(`{"title":"周末自驾"}`))
	createReq.Header.Set("Content-Type", "application/json")
	createResp := httptest.NewRecorder()
	router.ServeHTTP(createResp, createReq)
	if createResp.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", createResp.Code, createResp.Body.String())
	}

	var created struct {
		Map struct {
			ID       string `json:"id"`
			Revision int64  `json:"revision"`
		} `json:"map"`
		EditToken string `json:"edit_token"`
	}
	if err := json.Unmarshal(createResp.Body.Bytes(), &created); err != nil {
		t.Fatalf("unmarshal create response: %v", err)
	}
	if created.Map.ID == "" || created.EditToken == "" {
		t.Fatalf("missing map id or edit token")
	}

	// 2. GET + ETag / 304 验证
	getReq := httptest.NewRequest(http.MethodGet, "/api/maps/"+created.Map.ID, nil)
	getResp := httptest.NewRecorder()
	router.ServeHTTP(getResp, getReq)
	if getResp.Code != http.StatusOK {
		t.Fatalf("get status = %d", getResp.Code)
	}
	etag := getResp.Header().Get("ETag")
	if etag == "" {
		t.Fatalf("expected ETag header")
	}

	notModReq := httptest.NewRequest(http.MethodGet, "/api/maps/"+created.Map.ID, nil)
	notModReq.Header.Set("If-None-Match", etag)
	notModResp := httptest.NewRecorder()
	router.ServeHTTP(notModResp, notModReq)
	if notModResp.Code != http.StatusNotModified {
		t.Fatalf("expected 304 Not Modified, got %d", notModResp.Code)
	}

	// 反代压缩后弱 ETag（W/"..."）同样命中 304
	weakNotModReq := httptest.NewRequest(http.MethodGet, "/api/maps/"+created.Map.ID, nil)
	weakNotModReq.Header.Set("If-None-Match", "W/"+etag)
	weakNotModResp := httptest.NewRecorder()
	router.ServeHTTP(weakNotModResp, weakNotModReq)
	if weakNotModResp.Code != http.StatusNotModified {
		t.Fatalf("expected 304 Not Modified for weak ETag, got %d", weakNotModResp.Code)
	}

	// 3. 无 edit_token 写入被拒绝
	upsertBody := `{"base_revision":1,"features":[{"title":"起点","geometry":{"type":"Point","coordinates":[116.3974,39.9093]}}]}`
	unauthReq := httptest.NewRequest(http.MethodPost, "/api/maps/"+created.Map.ID+"/features/batch", bytes.NewBufferString(upsertBody))
	unauthReq.Header.Set("Content-Type", "application/json")
	unauthResp := httptest.NewRecorder()
	router.ServeHTTP(unauthResp, unauthReq)
	if unauthResp.Code != http.StatusForbidden {
		t.Fatalf("expected 403 without token, got %d", unauthResp.Code)
	}

	// 4. 正确 token 写入成功
	upsertReq := httptest.NewRequest(http.MethodPost, "/api/maps/"+created.Map.ID+"/features/batch", bytes.NewBufferString(upsertBody))
	upsertReq.Header.Set("Content-Type", "application/json")
	upsertReq.Header.Set("X-Edit-Token", created.EditToken)
	upsertResp := httptest.NewRecorder()
	router.ServeHTTP(upsertResp, upsertReq)
	if upsertResp.Code != http.StatusOK {
		t.Fatalf("upsert status = %d, body = %s", upsertResp.Code, upsertResp.Body.String())
	}

	// 5. 过期 base_revision 触发 409 乐观锁冲突
	conflictReq := httptest.NewRequest(http.MethodPost, "/api/maps/"+created.Map.ID+"/features/batch", bytes.NewBufferString(upsertBody))
	conflictReq.Header.Set("Content-Type", "application/json")
	conflictReq.Header.Set("X-Edit-Token", created.EditToken)
	conflictResp := httptest.NewRecorder()
	router.ServeHTTP(conflictResp, conflictReq)
	if conflictResp.Code != http.StatusConflict {
		t.Fatalf("expected 409 Conflict on stale base_revision, got %d", conflictResp.Code)
	}
}

func TestMCPStreamableHTTP(t *testing.T) {
	router := setupTestRouter(t)

	// 调用 MCP tools/list 验证协议联通
	listPayload := `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`
	req := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewBufferString(listPayload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	resp := httptest.NewRecorder()
	router.ServeHTTP(resp, req)

	if resp.Code != http.StatusOK {
		t.Fatalf("mcp tools/list status = %d, body = %s", resp.Code, resp.Body.String())
	}
	if !bytes.Contains(resp.Body.Bytes(), []byte("create_map")) || !bytes.Contains(resp.Body.Bytes(), []byte("upsert_features")) {
		t.Fatalf("unexpected mcp tools/list body: %s", resp.Body.String())
	}

	// 调用 create_map 工具
	callPayload := `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_map","arguments":{"title":"AI 规划路线"}}}`
	callReq := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewBufferString(callPayload))
	callReq.Header.Set("Content-Type", "application/json")
	callReq.Header.Set("Accept", "application/json, text/event-stream")
	callResp := httptest.NewRecorder()
	router.ServeHTTP(callResp, callReq)

	if callResp.Code != http.StatusOK {
		t.Fatalf("mcp create_map status = %d, body = %s", callResp.Code, callResp.Body.String())
	}
	if !bytes.Contains(callResp.Body.Bytes(), []byte("edit_token")) {
		t.Fatalf("expected edit_token in create_map output: %s", callResp.Body.String())
	}
}

func TestAdminListAndDeleteMaps(t *testing.T) {
	router := setupTestRouter(t)

	// 创建一张地图
	createReq := httptest.NewRequest(http.MethodPost, "/api/maps", bytes.NewBufferString(`{"title":"管理测试"}`))
	createReq.Header.Set("Content-Type", "application/json")
	createResp := httptest.NewRecorder()
	router.ServeHTTP(createResp, createReq)
	if createResp.Code != http.StatusCreated {
		t.Fatalf("create failed: %d", createResp.Code)
	}
	var created struct {
		Map struct {
			ID string `json:"id"`
		} `json:"map"`
	}
	_ = json.Unmarshal(createResp.Body.Bytes(), &created)

	// 无口令被拒绝
	unauthReq := httptest.NewRequest(http.MethodGet, "/api/admin/maps", nil)
	unauthResp := httptest.NewRecorder()
	router.ServeHTTP(unauthResp, unauthReq)
	if unauthResp.Code != http.StatusForbidden {
		t.Fatalf("expected 403 without admin key, got %d", unauthResp.Code)
	}

	// 正确口令可列出地图
	listReq := httptest.NewRequest(http.MethodGet, "/api/admin/maps", nil)
	listReq.Header.Set("X-Admin-Key", "secret-admin-key")
	listResp := httptest.NewRecorder()
	router.ServeHTTP(listResp, listReq)
	if listResp.Code != http.StatusOK || !bytes.Contains(listResp.Body.Bytes(), []byte(created.Map.ID)) {
		t.Fatalf("expected map id in admin list: code=%d body=%s", listResp.Code, listResp.Body.String())
	}

	// 正确口令可删除地图
	delReq := httptest.NewRequest(http.MethodDelete, "/api/admin/maps/"+created.Map.ID, nil)
	delReq.Header.Set("X-Admin-Key", "secret-admin-key")
	delResp := httptest.NewRecorder()
	router.ServeHTTP(delResp, delReq)
	if delResp.Code != http.StatusOK {
		t.Fatalf("expected 200 on admin delete, got %d", delResp.Code)
	}
}
