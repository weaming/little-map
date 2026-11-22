package config

import (
	"flag"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Config 保存服务运行所需的全部配置。
type Config struct {
	Addr           string
	DataDir        string
	DBPath         string
	BaseURL        string
	AmapKey        string
	GoogleMapsKey  string
	AdminKey       string
	HTTPProxy      string
	DefaultBasemap string
	TZ             string
	ListMaps       bool
}

// Load 从环境变量与命令行参数加载配置，命令行参数优先级高于环境变量。
func Load() *Config {
	defaultDataDir := defaultDataDirPath()
	cfg := &Config{
		Addr:           envOrDefault("ADDR", ":8080"),
		DataDir:        envOrDefault("DATA_DIR", defaultDataDir),
		DBPath:         strings.TrimSpace(os.Getenv("DB_PATH")),
		BaseURL:        strings.TrimRight(os.Getenv("BASE_URL"), "/"),
		AmapKey:        strings.TrimSpace(os.Getenv("AMAP_KEY")),
		GoogleMapsKey:  strings.TrimSpace(os.Getenv("GOOGLE_MAPS_KEY")),
		AdminKey:       strings.TrimSpace(os.Getenv("ADMIN_KEY")),
		HTTPProxy:      strings.TrimSpace(os.Getenv("LITTLE_MAP_PROXY")),
		DefaultBasemap: envOrDefault("DEFAULT_BASEMAP", "amap-vec"),
		TZ:             envOrDefault("TZ", "Asia/Hong_Kong"),
	}

	flag.StringVar(&cfg.Addr, "addr", cfg.Addr, "HTTP listen address")
	flag.StringVar(&cfg.DataDir, "data-dir", cfg.DataDir, "Data directory path (default: ~/.little-map)")
	flag.StringVar(&cfg.DBPath, "db", cfg.DBPath, "SQLite database file path (overrides data-dir)")
	flag.StringVar(&cfg.BaseURL, "base-url", cfg.BaseURL, "Public base URL for share links")
	flag.StringVar(&cfg.AmapKey, "amap-key", cfg.AmapKey, "Amap Web Service API key for POI search")
	flag.StringVar(&cfg.GoogleMapsKey, "google-key", cfg.GoogleMapsKey, "Google Maps API key for POI search")
	flag.StringVar(&cfg.AdminKey, "admin-key", cfg.AdminKey, "Admin key for listing/managing all maps")
	flag.StringVar(&cfg.HTTPProxy, "proxy", cfg.HTTPProxy, "Outbound HTTP proxy URL ('none' to disable)")
	flag.StringVar(&cfg.DefaultBasemap, "basemap", cfg.DefaultBasemap, "Default basemap id")
	flag.BoolVar(&cfg.ListMaps, "list-maps", false, "Print all stored maps with share/edit URLs and exit")
	flag.Parse()

	cfg.DataDir = expandHome(cfg.DataDir)
	if cfg.DBPath == "" {
		cfg.DBPath = filepath.Join(cfg.DataDir, "little-map.db")
	} else {
		cfg.DBPath = expandHome(cfg.DBPath)
	}
	cfg.BaseURL = strings.TrimRight(cfg.BaseURL, "/")
	return cfg
}

// Location 返回当前配置时区，解析失败时回退到 UTC+8。
func (c *Config) Location() *time.Location {
	loc, err := time.LoadLocation(c.TZ)
	if err != nil {
		return time.FixedZone("HKT", 8*3600)
	}
	return loc
}

// NewHTTPClient 构建支持代理开关的外部请求 HTTP 客户端。
func (c *Config) NewHTTPClient(timeout time.Duration) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	switch strings.ToLower(c.HTTPProxy) {
	case "":
		transport.Proxy = http.ProxyFromEnvironment
	case "none", "direct", "off":
		transport.Proxy = nil
	default:
		if parsed, err := url.Parse(c.HTTPProxy); err == nil {
			transport.Proxy = http.ProxyURL(parsed)
		}
	}

	return &http.Client{
		Timeout:   timeout,
		Transport: transport,
	}
}

func defaultDataDirPath() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ".little-map"
	}
	return filepath.Join(home, ".little-map")
}

func expandHome(p string) string {
	trimmed := strings.TrimSpace(p)
	if trimmed == "~" || strings.HasPrefix(trimmed, "~/") {
		home, err := os.UserHomeDir()
		if err == nil && home != "" {
			if trimmed == "~" {
				return home
			}
			return filepath.Join(home, trimmed[2:])
		}
	}
	return trimmed
}

func envOrDefault(key, fallback string) string {
	val := strings.TrimSpace(os.Getenv(key))
	if val == "" {
		return fallback
	}
	return val
}
