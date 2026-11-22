# little-map

轻量化免登录多人协作地图标注服务，前后端打包为单个零依赖二进制文件。

## 核心特性

- **免登录异步协作**：创建地图即得只读链接（`?m=<id>`）与编辑链接（`?m=<id>&t=<token>`），基于 `ETag`/`304` 轮询与 `revision` 乐观锁防覆盖，无 WebSocket 依赖，完美兼容 HTTP/3。
- **双底图自动纠偏**：支持高德矢量/卫星、Google 街道/卫星、OSM；后端统一存储 WGS-84 GeoJSON，前端切换高德底图时自动完成 `WGS-84 <-> GCJ-02` 纠偏。
- **地图标注与工具**：点/线/面标注、Markdown 备注（支持外链图片，零服务器存储压力）、独立测距/测面、GeoJSON 导入导出、POI 搜索（支持高德/谷歌 Key，无 Key 自动降级 OSM）。
- **AI MCP 接入**：内置 `/mcp` Streamable HTTP 端点，支持 AI 直接调用 `create_map`、`get_map`、`upsert_features`、`delete_features`、`search_place`。

## 参数与环境变量

| CLI 参数 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `--addr` | `ADDR` | `:8080` | 监听地址 |
| `--data-dir` | `DATA_DIR` | `~/.little-map` | 数据目录 |
| `--db` | `DB_PATH` | `<data-dir>/little-map.db` | SQLite 路径（覆盖 `--data-dir`） |
| `--base-url` | `BASE_URL` | 空 | MCP 返回分享链接的公开域名 |
| `--amap-key` | `AMAP_KEY` | 空 | 高德 Web 服务 Key（POI 搜索） |
| `--google-key` | `GOOGLE_MAPS_KEY` | 空 | Google Places Key（POI 搜索） |
| `--proxy` | `LITTLE_MAP_PROXY` | 跟随系统环境 | 出站 HTTP 代理，填 `none` 禁用 |
| `--basemap` | `DEFAULT_BASEMAP` | `amap-vec` | 默认底图 ID |
