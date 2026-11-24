package geo

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
)

const (
	gcjAxis = 6378245.0
	gcjEE   = 0.00669342162296594323
	bdXPi   = math.Pi * 3000.0 / 180.0
)

// Geometry 表示标准 WGS-84 GeoJSON 几何对象。
type Geometry struct {
	Type        string          `json:"type"`
	Coordinates json.RawMessage `json:"coordinates"`
}

// ValidateGeometry 校验 GeoJSON 几何类型与经纬度合法性。
func ValidateGeometry(geom Geometry) error {
	switch geom.Type {
	case "Point":
		var coord []float64
		if err := json.Unmarshal(geom.Coordinates, &coord); err != nil {
			return fmt.Errorf("invalid Point coordinates: %w", err)
		}
		return validatePosition(coord)

	case "LineString":
		var coords [][]float64
		if err := json.Unmarshal(geom.Coordinates, &coords); err != nil {
			return fmt.Errorf("invalid LineString coordinates: %w", err)
		}
		if len(coords) < 2 {
			return errors.New("LineString requires at least 2 positions")
		}
		for _, pos := range coords {
			if err := validatePosition(pos); err != nil {
				return err
			}
		}
		return nil

	case "Polygon":
		var rings [][][]float64
		if err := json.Unmarshal(geom.Coordinates, &rings); err != nil {
			return fmt.Errorf("invalid Polygon coordinates: %w", err)
		}
		if len(rings) == 0 || len(rings[0]) < 4 {
			return errors.New("Polygon requires at least one linear ring with 4 positions")
		}
		for _, ring := range rings {
			for _, pos := range ring {
				if err := validatePosition(pos); err != nil {
					return err
				}
			}
		}
		return nil

	default:
		return fmt.Errorf("unsupported geometry type: %q (supported: Point, LineString, Polygon)", geom.Type)
	}
}

func validatePosition(pos []float64) error {
	if len(pos) < 2 {
		return errors.New("coordinate position must have [lng, lat]")
	}
	lng, lat := pos[0], pos[1]
	if math.IsNaN(lng) || math.IsNaN(lat) || math.IsInf(lng, 0) || math.IsInf(lat, 0) {
		return errors.New("coordinate contains NaN or Inf")
	}
	if lng < -180 || lng > 180 || lat < -90 || lat > 90 {
		return fmt.Errorf("coordinate out of range: [%f, %f]", lng, lat)
	}
	return nil
}

// WGS84ToGCJ02 将 WGS-84 坐标转换为 GCJ-02（高德火星坐标）。
func WGS84ToGCJ02(lng, lat float64) (float64, float64) {
	if isOutOfChina(lng, lat) {
		return lng, lat
	}
	dLat, dLng := gcjDelta(lng, lat)
	return lng + dLng, lat + dLat
}

// GCJ02ToWGS84 将 GCJ-02 坐标迭代逆解为高精度 WGS-84 坐标。
func GCJ02ToWGS84(lng, lat float64) (float64, float64) {
	if isOutOfChina(lng, lat) {
		return lng, lat
	}
	wLng, wLat := lng, lat
	for range 5 {
		gLng, gLat := WGS84ToGCJ02(wLng, wLat)
		wLng += lng - gLng
		wLat += lat - gLat
	}
	return wLng, wLat
}

// BD09ToGCJ02 将百度 BD-09 坐标转换为 GCJ-02 坐标。
func BD09ToGCJ02(lng, lat float64) (float64, float64) {
	if isOutOfChina(lng, lat) {
		return lng, lat
	}
	x := lng - 0.0065
	y := lat - 0.006
	z := math.Hypot(x, y) - 0.00002*math.Sin(y*bdXPi)
	theta := math.Atan2(y, x) - 0.000003*math.Cos(x*bdXPi)
	return z * math.Cos(theta), z * math.Sin(theta)
}

// BD09ToWGS84 将百度 BD-09 坐标（如贝壳/链家小区坐标）转换为标准 WGS-84 坐标。
func BD09ToWGS84(lng, lat float64) (float64, float64) {
	if isOutOfChina(lng, lat) {
		return lng, lat
	}
	gLng, gLat := BD09ToGCJ02(lng, lat)
	return GCJ02ToWGS84(gLng, gLat)
}

func isOutOfChina(lng, lat float64) bool {
	return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}

func gcjDelta(lng, lat float64) (float64, float64) {
	dLat := transformLat(lng-105.0, lat-35.0)
	dLng := transformLng(lng-105.0, lat-35.0)
	radLat := lat / 180.0 * math.Pi
	magic := math.Sin(radLat)
	magic = 1 - gcjEE*magic*magic
	sqrtMagic := math.Sqrt(magic)
	dLat = (dLat * 180.0) / ((gcjAxis * (1 - gcjEE)) / (magic * sqrtMagic) * math.Pi)
	dLng = (dLng * 180.0) / (gcjAxis / sqrtMagic * math.Cos(radLat) * math.Pi)
	return dLat, dLng
}

func transformLat(x, y float64) float64 {
	ret := -100.0 + 2.0*x + 3.0*y + 0.2*y*y + 0.1*x*y + 0.2*math.Sqrt(math.Abs(x))
	ret += (20.0*math.Sin(6.0*x*math.Pi) + 20.0*math.Sin(2.0*x*math.Pi)) * 2.0 / 3.0
	ret += (20.0*math.Sin(y*math.Pi) + 40.0*math.Sin(y/3.0*math.Pi)) * 2.0 / 3.0
	ret += (160.0*math.Sin(y/12.0*math.Pi) + 320*math.Sin(y*math.Pi/30.0)) * 2.0 / 3.0
	return ret
}

func transformLng(x, y float64) float64 {
	ret := 300.0 + x + 2.0*y + 0.1*x*x + 0.1*x*y + 0.1*math.Sqrt(math.Abs(x))
	ret += (20.0*math.Sin(6.0*x*math.Pi) + 20.0*math.Sin(2.0*x*math.Pi)) * 2.0 / 3.0
	ret += (20.0*math.Sin(x*math.Pi) + 40.0*math.Sin(x/3.0*math.Pi)) * 2.0 / 3.0
	ret += (150.0*math.Sin(x/12.0*math.Pi) + 300.0*math.Sin(x/30.0*math.Pi)) * 2.0 / 3.0
	return ret
}
