package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"little-map/pkg/geo"

	_ "modernc.org/sqlite"
)

var (
	ErrNotFound         = errors.New("resource not found")
	ErrForbidden        = errors.New("invalid edit token")
	ErrRevisionConflict = errors.New("revision conflict")
)

// Map 表示一张可分享的地图元信息。
type Map struct {
	ID          string  `json:"id"`
	EditToken   string  `json:"-"`
	Title       string  `json:"title"`
	Description string  `json:"description"`
	CenterLng   float64 `json:"center_lng"`
	CenterLat   float64 `json:"center_lat"`
	Zoom        float64 `json:"zoom"`
	Basemap     string  `json:"basemap"`
	Revision    int64   `json:"revision"`
	CreatedAt   string  `json:"created_at"`
	UpdatedAt   string  `json:"updated_at"`
}

// Feature 表示地图上的单个 WGS-84 GeoJSON 标注要素。
type Feature struct {
	ID          string       `json:"id"`
	MapID       string       `json:"map_id"`
	Title       string       `json:"title"`
	Description string       `json:"description"`
	Category    string       `json:"category"`
	Color       string       `json:"color"`
	Icon        string       `json:"icon"`
	Geometry    geo.Geometry `json:"geometry"`
	Visible     bool         `json:"visible"`
	SortOrder   int          `json:"sort_order"`
	CreatedAt   string       `json:"created_at"`
	UpdatedAt   string       `json:"updated_at"`
}

// MapPatch 定义可更新的地图元信息字段。
type MapPatch struct {
	Title       *string
	Description *string
	CenterLng   *float64
	CenterLat   *float64
	Zoom        *float64
	Basemap     *string
}

// MapSummary 表示管理视角下的地图概要（含编辑令牌与标注数量）。
type MapSummary struct {
	ID           string `json:"id"`
	EditToken    string `json:"edit_token"`
	Title        string `json:"title"`
	Description  string `json:"description"`
	FeatureCount int    `json:"feature_count"`
	Revision     int64  `json:"revision"`
	CreatedAt    string `json:"created_at"`
	UpdatedAt    string `json:"updated_at"`
}

// Store 封装 SQLite 数据持久化与事务乐观锁。
type Store struct {
	db  *sql.DB
	loc *time.Location
}

// Open 初始化 SQLite 连接并创建初始化表结构。
func Open(dbPath string, loc *time.Location) (*Store, error) {
	if dbPath != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
			return nil, fmt.Errorf("create db dir: %w", err)
		}
	}

	dsn := dbPath
	if dbPath != ":memory:" {
		dsn = fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=foreign_keys(ON)&_pragma=busy_timeout(5000)", dbPath)
	}

	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)

	if loc == nil {
		loc = time.FixedZone("HKT", 8*3600)
	}

	st := &Store{db: db, loc: loc}
	if err := st.initSchema(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return st, nil
}

// Close 关闭数据库连接。
func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) initSchema() error {
	const schema = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS maps (
	id TEXT PRIMARY KEY,
	edit_token TEXT NOT NULL,
	title TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	center_lng REAL NOT NULL,
	center_lat REAL NOT NULL,
	zoom REAL NOT NULL,
	basemap TEXT NOT NULL DEFAULT 'amap-vec',
	revision INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS features (
	id TEXT PRIMARY KEY,
	map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
	title TEXT NOT NULL DEFAULT '',
	description TEXT NOT NULL DEFAULT '',
	category TEXT NOT NULL DEFAULT '',
	color TEXT NOT NULL DEFAULT '#2563eb',
	icon TEXT NOT NULL DEFAULT 'pin',
	geometry_type TEXT NOT NULL,
	geometry_json TEXT NOT NULL,
	visible INTEGER NOT NULL DEFAULT 1,
	sort_order INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_features_map_order ON features(map_id, sort_order, created_at);
`
	if _, err := s.db.Exec(schema); err != nil {
		return fmt.Errorf("init schema: %w", err)
	}
	return nil
}

func (s *Store) nowISO() string {
	return time.Now().In(s.loc).Format(time.RFC3339)
}

// CreateMap 插入一张新地图。
func (s *Store) CreateMap(ctx context.Context, m Map) (*Map, error) {
	now := s.nowISO()
	m.Revision = 1
	m.CreatedAt = now
	m.UpdatedAt = now

	const q = `
INSERT INTO maps (id, edit_token, title, description, center_lng, center_lat, zoom, basemap, revision, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`
	if _, err := s.db.ExecContext(ctx, q,
		m.ID, m.EditToken, m.Title, m.Description, m.CenterLng, m.CenterLat, m.Zoom, m.Basemap, m.Revision, m.CreatedAt, m.UpdatedAt,
	); err != nil {
		return nil, fmt.Errorf("insert map: %w", err)
	}
	return &m, nil
}

// GetMap 获取地图信息及其全部标注列表。
func (s *Store) GetMap(ctx context.Context, mapID string) (*Map, []Feature, error) {
	const qMap = `
SELECT id, edit_token, title, description, center_lng, center_lat, zoom, basemap, revision, created_at, updated_at
FROM maps WHERE id = ?
`
	var m Map
	err := s.db.QueryRowContext(ctx, qMap, mapID).Scan(
		&m.ID, &m.EditToken, &m.Title, &m.Description, &m.CenterLng, &m.CenterLat,
		&m.Zoom, &m.Basemap, &m.Revision, &m.CreatedAt, &m.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, ErrNotFound
	}
	if err != nil {
		return nil, nil, fmt.Errorf("query map: %w", err)
	}

	const qFeat = `
SELECT id, map_id, title, description, category, color, icon, geometry_type, geometry_json, visible, sort_order, created_at, updated_at
FROM features WHERE map_id = ?
ORDER BY sort_order ASC, created_at ASC
`
	rows, err := s.db.QueryContext(ctx, qFeat, mapID)
	if err != nil {
		return nil, nil, fmt.Errorf("query features: %w", err)
	}
	defer rows.Close()

	features := make([]Feature, 0)
	for rows.Next() {
		var f Feature
		var geomType, geomJSON string
		var visibleInt int
		if err := rows.Scan(
			&f.ID, &f.MapID, &f.Title, &f.Description, &f.Category, &f.Color, &f.Icon,
			&geomType, &geomJSON, &visibleInt, &f.SortOrder, &f.CreatedAt, &f.UpdatedAt,
		); err != nil {
			return nil, nil, fmt.Errorf("scan feature: %w", err)
		}
		f.Geometry = geo.Geometry{
			Type:        geomType,
			Coordinates: json.RawMessage(geomJSON),
		}
		f.Visible = visibleInt != 0
		features = append(features, f)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("iterate features: %w", err)
	}
	return &m, features, nil
}

// UpdateMapMeta 校验 editToken 与乐观锁版本后更新地图元信息。
func (s *Store) UpdateMapMeta(ctx context.Context, mapID, editToken string, baseRevision int64, patch MapPatch) (*Map, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	cur, err := lockAndVerifyMapTx(ctx, tx, mapID, editToken, baseRevision)
	if err != nil {
		return nil, err
	}

	if patch.Title != nil {
		cur.Title = *patch.Title
	}
	if patch.Description != nil {
		cur.Description = *patch.Description
	}
	if patch.CenterLng != nil {
		cur.CenterLng = *patch.CenterLng
	}
	if patch.CenterLat != nil {
		cur.CenterLat = *patch.CenterLat
	}
	if patch.Zoom != nil {
		cur.Zoom = *patch.Zoom
	}
	if patch.Basemap != nil {
		cur.Basemap = *patch.Basemap
	}
	cur.Revision++
	cur.UpdatedAt = s.nowISO()

	const q = `
UPDATE maps
SET title = ?, description = ?, center_lng = ?, center_lat = ?, zoom = ?, basemap = ?, revision = ?, updated_at = ?
WHERE id = ?
`
	if _, err := tx.ExecContext(ctx, q,
		cur.Title, cur.Description, cur.CenterLng, cur.CenterLat, cur.Zoom, cur.Basemap, cur.Revision, cur.UpdatedAt, cur.ID,
	); err != nil {
		return nil, fmt.Errorf("update map: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit tx: %w", err)
	}
	return cur, nil
}

// UpsertFeatures 在同一事务中批量新增或更新标注并递增地图 revision。
func (s *Store) UpsertFeatures(ctx context.Context, mapID, editToken string, baseRevision int64, items []Feature) (int64, []Feature, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	cur, err := lockAndVerifyMapTx(ctx, tx, mapID, editToken, baseRevision)
	if err != nil {
		return 0, nil, err
	}

	now := s.nowISO()
	const qUpsert = `
INSERT INTO features (id, map_id, title, description, category, color, icon, geometry_type, geometry_json, visible, sort_order, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
	title = excluded.title,
	description = excluded.description,
	category = excluded.category,
	color = excluded.color,
	icon = excluded.icon,
	geometry_type = excluded.geometry_type,
	geometry_json = excluded.geometry_json,
	visible = excluded.visible,
	sort_order = excluded.sort_order,
	updated_at = excluded.updated_at
WHERE features.map_id = excluded.map_id
`
	saved := make([]Feature, 0, len(items))
	for _, item := range items {
		item.MapID = mapID
		if item.CreatedAt == "" {
			item.CreatedAt = now
		}
		item.UpdatedAt = now
		vis := 0
		if item.Visible {
			vis = 1
		}
		if _, err := tx.ExecContext(ctx, qUpsert,
			item.ID, item.MapID, item.Title, item.Description, item.Category, item.Color, item.Icon,
			item.Geometry.Type, string(item.Geometry.Coordinates), vis, item.SortOrder, item.CreatedAt, item.UpdatedAt,
		); err != nil {
			return 0, nil, fmt.Errorf("upsert feature %s: %w", item.ID, err)
		}
		saved = append(saved, item)
	}

	newRev := cur.Revision + 1
	if _, err := tx.ExecContext(ctx, `UPDATE maps SET revision = ?, updated_at = ? WHERE id = ?`, newRev, now, mapID); err != nil {
		return 0, nil, fmt.Errorf("bump revision: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return 0, nil, fmt.Errorf("commit tx: %w", err)
	}
	return newRev, saved, nil
}

// DeleteFeatures 批量删除指定地图下的标注并递增 revision。
func (s *Store) DeleteFeatures(ctx context.Context, mapID, editToken string, baseRevision int64, featureIDs []string) (int64, int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	cur, err := lockAndVerifyMapTx(ctx, tx, mapID, editToken, baseRevision)
	if err != nil {
		return 0, 0, err
	}

	if len(featureIDs) == 0 {
		return cur.Revision, 0, nil
	}

	placeholders := make([]string, len(featureIDs))
	args := make([]any, 0, len(featureIDs)+1)
	args = append(args, mapID)
	for i, id := range featureIDs {
		placeholders[i] = "?"
		args = append(args, id)
	}

	q := fmt.Sprintf("DELETE FROM features WHERE map_id = ? AND id IN (%s)", strings.Join(placeholders, ","))
	res, err := tx.ExecContext(ctx, q, args...)
	if err != nil {
		return 0, 0, fmt.Errorf("delete features: %w", err)
	}
	deleted, _ := res.RowsAffected()

	newRev := cur.Revision + 1
	if _, err := tx.ExecContext(ctx, `UPDATE maps SET revision = ?, updated_at = ? WHERE id = ?`, newRev, s.nowISO(), mapID); err != nil {
		return 0, 0, fmt.Errorf("bump revision: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return 0, 0, fmt.Errorf("commit tx: %w", err)
	}
	return newRev, deleted, nil
}

// ListMaps 按更新时间倒序列出数据库中的全部地图概要。
func (s *Store) ListMaps(ctx context.Context) ([]MapSummary, error) {
	const q = `
SELECT m.id, m.edit_token, m.title, m.description, COUNT(f.id) AS feature_count, m.revision, m.created_at, m.updated_at
FROM maps m
LEFT JOIN features f ON f.map_id = m.id
GROUP BY m.id
ORDER BY m.updated_at DESC
`
	rows, err := s.db.QueryContext(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("list maps: %w", err)
	}
	defer rows.Close()

	list := make([]MapSummary, 0)
	for rows.Next() {
		var item MapSummary
		if err := rows.Scan(
			&item.ID, &item.EditToken, &item.Title, &item.Description,
			&item.FeatureCount, &item.Revision, &item.CreatedAt, &item.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan map summary: %w", err)
		}
		list = append(list, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate map summaries: %w", err)
	}
	return list, nil
}

// DeleteMap 删除指定地图及其全部标注（外键级联删除）。
func (s *Store) DeleteMap(ctx context.Context, mapID string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM maps WHERE id = ?`, mapID)
	if err != nil {
		return fmt.Errorf("delete map: %w", err)
	}
	affected, _ := res.RowsAffected()
	if affected == 0 {
		return ErrNotFound
	}
	return nil
}

// CloneMap 在单个事务内完整深拷贝一张地图及其全部标注为新地图。
func (s *Store) CloneMap(ctx context.Context, srcMapID, newMapID, newEditToken, customTitle string, nextFeatureID func() (string, error)) (*Map, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	const qSrc = `
SELECT title, description, center_lng, center_lat, zoom, basemap
FROM maps WHERE id = ?
`
	var src Map
	err = tx.QueryRowContext(ctx, qSrc, srcMapID).Scan(
		&src.Title, &src.Description, &src.CenterLng, &src.CenterLat, &src.Zoom, &src.Basemap,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("query source map: %w", err)
	}

	title := strings.TrimSpace(customTitle)
	if title == "" {
		title = src.Title + " (副本)"
	}

	now := s.nowISO()
	cloned := Map{
		ID:          newMapID,
		EditToken:   newEditToken,
		Title:       title,
		Description: src.Description,
		CenterLng:   src.CenterLng,
		CenterLat:   src.CenterLat,
		Zoom:        src.Zoom,
		Basemap:     src.Basemap,
		Revision:    1,
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	const qInsertMap = `
INSERT INTO maps (id, edit_token, title, description, center_lng, center_lat, zoom, basemap, revision, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`
	if _, err := tx.ExecContext(ctx, qInsertMap,
		cloned.ID, cloned.EditToken, cloned.Title, cloned.Description,
		cloned.CenterLng, cloned.CenterLat, cloned.Zoom, cloned.Basemap,
		cloned.Revision, cloned.CreatedAt, cloned.UpdatedAt,
	); err != nil {
		return nil, fmt.Errorf("insert cloned map: %w", err)
	}

	const qFeat = `
SELECT title, description, category, color, icon, geometry_type, geometry_json, visible, sort_order
FROM features WHERE map_id = ?
ORDER BY sort_order ASC, created_at ASC
`
	rows, err := tx.QueryContext(ctx, qFeat, srcMapID)
	if err != nil {
		return nil, fmt.Errorf("query source features: %w", err)
	}

	type rawFeature struct {
		title, desc, cat, color, icon, geomType, geomJSON string
		visible, sortOrder                                int
	}
	var srcFeatures []rawFeature
	for rows.Next() {
		var rf rawFeature
		if err := rows.Scan(&rf.title, &rf.desc, &rf.cat, &rf.color, &rf.icon, &rf.geomType, &rf.geomJSON, &rf.visible, &rf.sortOrder); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("scan source feature: %w", err)
		}
		srcFeatures = append(srcFeatures, rf)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, fmt.Errorf("iterate source features: %w", err)
	}
	_ = rows.Close()

	const qInsertFeat = `
INSERT INTO features (id, map_id, title, description, category, color, icon, geometry_type, geometry_json, visible, sort_order, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`
	for _, rf := range srcFeatures {
		fid, err := nextFeatureID()
		if err != nil {
			return nil, fmt.Errorf("generate cloned feature id: %w", err)
		}
		if _, err := tx.ExecContext(ctx, qInsertFeat,
			fid, cloned.ID, rf.title, rf.desc, rf.cat, rf.color, rf.icon,
			rf.geomType, rf.geomJSON, rf.visible, rf.sortOrder, now, now,
		); err != nil {
			return nil, fmt.Errorf("insert cloned feature: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit clone tx: %w", err)
	}
	return &cloned, nil
}

func lockAndVerifyMapTx(ctx context.Context, tx *sql.Tx, mapID, editToken string, baseRevision int64) (*Map, error) {
	const q = `
SELECT id, edit_token, title, description, center_lng, center_lat, zoom, basemap, revision, created_at, updated_at
FROM maps WHERE id = ?
`
	var m Map
	err := tx.QueryRowContext(ctx, q, mapID).Scan(
		&m.ID, &m.EditToken, &m.Title, &m.Description, &m.CenterLng, &m.CenterLat,
		&m.Zoom, &m.Basemap, &m.Revision, &m.CreatedAt, &m.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("query map in tx: %w", err)
	}
	if editToken == "" || editToken != m.EditToken {
		return nil, ErrForbidden
	}
	if baseRevision > 0 && baseRevision != m.Revision {
		return nil, ErrRevisionConflict
	}
	return &m, nil
}
