package store

import "testing"

func TestPhaseBigrams(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		phases []string
		want   int
	}{
		{"three phases", []string{"read", "write", "test"}, 2},
		{"single phase", []string{"read"}, 0},
		{"empty", []string{}, 0},
		{"four phases", []string{"read", "plan", "write", "test"}, 3},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := phaseBigrams(tt.phases)
			if len(got) != tt.want {
				t.Errorf("phaseBigrams(%v) has %d bigrams, want %d", tt.phases, len(got), tt.want)
			}
		})
	}
}

func TestJaccardSimilarity(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		a    map[string]bool
		b    map[string]bool
		want float64
	}{
		{
			"identical",
			map[string]bool{"a": true, "b": true},
			map[string]bool{"a": true, "b": true},
			1.0,
		},
		{
			"no overlap",
			map[string]bool{"a": true, "b": true},
			map[string]bool{"c": true, "d": true},
			0.0,
		},
		{
			"half overlap",
			map[string]bool{"a": true, "b": true},
			map[string]bool{"b": true, "c": true},
			1.0 / 3.0,
		},
		{
			"both empty",
			map[string]bool{},
			map[string]bool{},
			0.0,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := jaccardSimilarity(tt.a, tt.b)
			diff := got - tt.want
			if diff < -0.001 || diff > 0.001 {
				t.Errorf("jaccardSimilarity() = %v, want %v", got, tt.want)
			}
		})
	}
}
