package geo

import (
	"encoding/json"
	"math"
	"testing"
)

func TestGCJ02RoundTrip(t *testing.T) {
	// 北京天安门附近 WGS-84
	origLng, origLat := 116.3912757, 39.906217
	gLng, gLat := WGS84ToGCJ02(origLng, origLat)
	if math.Abs(gLng-origLng) < 0.001 || math.Abs(gLat-origLat) < 0.0005 {
		t.Fatalf("expected noticeable GCJ-02 offset in China, got (%f, %f)", gLng, gLat)
	}

	backLng, backLat := GCJ02ToWGS84(gLng, gLat)
	if math.Abs(backLng-origLng) > 1e-6 || math.Abs(backLat-origLat) > 1e-6 {
		t.Fatalf("roundtrip drift too large: got (%f, %f), want (%f, %f)", backLng, backLat, origLng, origLat)
	}

	// 海外坐标不做偏移
	nyLng, nyLat := -73.9857, 40.7484
	nyGLng, nyGLat := WGS84ToGCJ02(nyLng, nyLat)
	if nyGLng != nyLng || nyGLat != nyLat {
		t.Fatalf("expected no offset outside China")
	}
}

func TestValidateGeometry(t *testing.T) {
	point := Geometry{Type: "Point", Coordinates: json.RawMessage(`[116.3974, 39.9093]`)}
	if err := ValidateGeometry(point); err != nil {
		t.Fatalf("valid point failed: %v", err)
	}

	bad := Geometry{Type: "Point", Coordinates: json.RawMessage(`[200, 39.9]`)}
	if err := ValidateGeometry(bad); err == nil {
		t.Fatalf("expected out-of-range point to fail")
	}
}
