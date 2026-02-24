package locale

import "testing"

func TestDetect_JA(t *testing.T) {
	t.Setenv("LC_ALL", "")
	t.Setenv("LC_MESSAGES", "")
	t.Setenv("LANG", "ja_JP.UTF-8")
	lang := Detect()
	if lang.Code != "ja" || lang.Name != "Japanese" {
		t.Errorf("got %+v, want ja/Japanese", lang)
	}
}

func TestDetect_EN(t *testing.T) {
	t.Setenv("LC_ALL", "")
	t.Setenv("LC_MESSAGES", "")
	t.Setenv("LANG", "en_US.UTF-8")
	lang := Detect()
	if lang.Code != "en" || lang.Name != "English" {
		t.Errorf("got %+v, want en/English", lang)
	}
}

func TestDetect_LCAllOverridesLang(t *testing.T) {
	t.Setenv("LANG", "en_US.UTF-8")
	t.Setenv("LC_MESSAGES", "")
	t.Setenv("LC_ALL", "ja_JP.UTF-8")
	lang := Detect()
	if lang.Code != "ja" {
		t.Errorf("got %s, want ja", lang.Code)
	}
}

func TestDetect_LCMessagesOverridesLang(t *testing.T) {
	t.Setenv("LANG", "en_US.UTF-8")
	t.Setenv("LC_ALL", "")
	t.Setenv("LC_MESSAGES", "ko_KR.UTF-8")
	lang := Detect()
	if lang.Code != "ko" {
		t.Errorf("got %s, want ko", lang.Code)
	}
}

func TestDetect_Fallback(t *testing.T) {
	t.Setenv("LC_ALL", "")
	t.Setenv("LC_MESSAGES", "")
	t.Setenv("LANG", "")
	lang := Detect()
	if lang.Code != "en" || lang.Name != "English" {
		t.Errorf("got %+v, want en/English", lang)
	}
}

func TestDetect_POSIX(t *testing.T) {
	t.Setenv("LC_ALL", "POSIX")
	t.Setenv("LC_MESSAGES", "")
	t.Setenv("LANG", "ja_JP.UTF-8")
	lang := Detect()
	// POSIX is skipped, falls through to LANG
	if lang.Code != "ja" {
		t.Errorf("got %s, want ja", lang.Code)
	}
}

func TestDetect_UnknownCode(t *testing.T) {
	t.Setenv("LC_ALL", "")
	t.Setenv("LC_MESSAGES", "")
	t.Setenv("LANG", "xx_XX.UTF-8")
	lang := Detect()
	if lang.Code != "en" {
		t.Errorf("unknown code should fallback to en, got %s", lang.Code)
	}
}
