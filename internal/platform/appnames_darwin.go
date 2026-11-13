package platform

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"howett.net/plist"
)

// 应用的名字在不同语言下不一样（时钟 / Clock、微信 / WeChat）。系统只按当前进程的语言给一个，
// 这里把中文名和英文名都读出来，这样无论系统是什么语言，两种写法都搜得到。

var appNameKeys = []string{"CFBundleDisplayName", "CFBundleName"}

// 各语言目录的写法不统一，新旧两种都要认。
var (
	zhLocales = []string{"zh-Hans", "zh_CN", "zh-Hans-CN", "zh_Hans", "zh", "zh-Hant", "zh_TW", "zh_HK"}
	enLocales = []string{"en", "English", "en_US", "en-US", "Base", "en_GB", "en-GB"}
)

// AppNames 返回应用包的中文名和英文名；读不到的为空。
func AppNames(appPath string) (zh, en string) {
	if !strings.HasSuffix(appPath, ".app") {
		return "", ""
	}
	res := filepath.Join(appPath, "Contents", "Resources")
	if _, err := os.Stat(res); err != nil {
		// iOS 应用包在 Wrapper 里再套一层。
		if m, _ := filepath.Glob(filepath.Join(appPath, "Wrapper", "*.app")); len(m) > 0 {
			res = m[0]
		}
	}
	// 系统应用把所有语言放在一个 loctable 里。
	if table := readPlist(filepath.Join(res, "InfoPlist.loctable")); table != nil {
		zh = fromTable(table, zhLocales)
		en = fromTable(table, enLocales)
	}
	if zh == "" {
		zh = fromLproj(res, zhLocales)
	}
	if en == "" {
		en = fromLproj(res, enLocales)
	}
	if en == "" {
		info := readPlist(filepath.Join(appPath, "Contents", "Info.plist"))
		if info == nil {
			info = readPlist(filepath.Join(res, "Info.plist"))
		}
		en = pickName(info)
	}
	return zh, en
}

func readPlist(path string) map[string]any {
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 || len(data) > 8<<20 {
		return nil
	}
	var out map[string]any
	if _, err := plist.Unmarshal(data, &out); err != nil {
		return nil
	}
	return out
}

func pickName(dict map[string]any) string {
	for _, k := range appNameKeys {
		if s, ok := dict[k].(string); ok && strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
	}
	return ""
}

func fromTable(table map[string]any, locales []string) string {
	for _, l := range locales {
		if d, ok := table[l].(map[string]any); ok {
			if s := pickName(d); s != "" {
				return s
			}
		}
	}
	return ""
}

func fromLproj(res string, locales []string) string {
	for _, l := range locales {
		if s := pickName(readPlist(filepath.Join(res, l+".lproj", "InfoPlist.strings"))); s != "" {
			return s
		}
	}
	return ""
}

// PrefersChinese 报告系统的首选语言是不是中文。
func PrefersChinese() bool {
	out, err := Command(context.Background(), "defaults", "read", "-g", "AppleLanguages").Output()
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.Trim(strings.TrimSpace(line), `",`)
		if line == "" || line == "(" || line == ")" {
			continue
		}
		return strings.HasPrefix(line, "zh")
	}
	return false
}
