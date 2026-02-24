package locale

import (
	"os"
	"strings"
)

// Lang holds the detected language information.
type Lang struct {
	Code string // ISO 639-1, e.g. "ja", "en"
	Name string // English name, e.g. "Japanese", "English"
}

// Detect reads LC_ALL / LC_MESSAGES / LANG environment variables
// and returns the detected language. Falls back to English.
func Detect() Lang {
	// Priority: LC_ALL > LC_MESSAGES > LANG
	for _, key := range []string{"LC_ALL", "LC_MESSAGES", "LANG"} {
		raw := os.Getenv(key)
		if raw != "" && raw != "C" && raw != "POSIX" {
			return parse(raw)
		}
	}
	return Lang{Code: "en", Name: "English"}
}

func parse(raw string) Lang {
	// "ja_JP.UTF-8" -> "ja"
	code := raw
	if i := strings.IndexAny(code, "_."); i >= 0 {
		code = code[:i]
	}
	code = strings.ToLower(code)

	if name, ok := langNames[code]; ok {
		return Lang{Code: code, Name: name}
	}
	return Lang{Code: "en", Name: "English"}
}

var langNames = map[string]string{
	"en": "English",
	"ja": "Japanese",
	"zh": "Chinese",
	"ko": "Korean",
	"es": "Spanish",
	"fr": "French",
	"de": "German",
	"pt": "Portuguese",
	"ru": "Russian",
	"it": "Italian",
	"ar": "Arabic",
	"hi": "Hindi",
	"th": "Thai",
	"vi": "Vietnamese",
	"tr": "Turkish",
	"pl": "Polish",
	"nl": "Dutch",
	"sv": "Swedish",
}
