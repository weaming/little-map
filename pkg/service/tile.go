package service

import (
	"context"
	"fmt"
	"io"
	"net/http"
)

// FetchOverlayTile 仅按严格白名单代理透明路网瓦片，供浏览器 Canvas 跨域像素纠偏使用。
func (s *Service) FetchOverlayTile(ctx context.Context, provider string, z, x, y int) ([]byte, string, error) {
	if z < 0 || z > 22 || x < 0 || y < 0 {
		return nil, "", fmt.Errorf("%w: invalid tile coordinates", ErrInvalidInput)
	}

	var targetURL string
	switch provider {
	case "amap-label":
		sub := (x+y)%4 + 1
		targetURL = fmt.Sprintf("https://webst0%d.is.autonavi.com/appmaptile?style=8&ltype=4&x=%d&y=%d&z=%d", sub, x, y, z)
	case "amap-road":
		sub := (x+y)%4 + 1
		targetURL = fmt.Sprintf("https://webst0%d.is.autonavi.com/appmaptile?style=8&x=%d&y=%d&z=%d", sub, x, y, z)
	case "amap-traffic":
		targetURL = fmt.Sprintf("https://tm.amap.com/trafficengine/mapabc/traffictile?v=1.0&t=1&x=%d&y=%d&z=%d", x, y, z)
	case "google-road":
		sub := (x + y) % 4
		targetURL = fmt.Sprintf("https://mt%d.google.com/vt/lyrs=h&hl=zh-CN&scale=2&x=%d&y=%d&z=%d", sub, x, y, z)
	default:
		return nil, "", fmt.Errorf("%w: unsupported overlay provider %q", ErrInvalidInput, provider)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("fetch overlay tile: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("upstream tile status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return nil, "", fmt.Errorf("read tile body: %w", err)
	}
	contentType := resp.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "image/png"
	}
	return body, contentType, nil
}
