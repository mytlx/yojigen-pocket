package providers

import (
	"context"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"yojigen-pocket/internal/core"
)

// Calc 是计算器：四则运算、函数、进制和单位换算。
type Calc struct {
	// Record 在结果被复制或粘贴时调用，用来记进计算历史。
	Record func(expr, result string)
}

// Info 实现 core.Provider。
func (c Calc) Info() core.Info {
	return core.Info{ID: "calc", Title: "计算器", Icon: "svg:calculator"}
}

// Search 实现 core.Provider。
func (c Calc) Search(_ context.Context, req *core.Request) []core.Item {
	text := strings.TrimSpace(req.Text)
	if text == "" {
		return nil
	}
	if !req.Scoped && !LooksLikeMath(text) {
		return nil
	}
	results, err := Evaluate(text)
	if err != nil {
		if req.Scoped {
			return []core.Item{{
				ID: "calc:error", Title: "算式有误", Subtitle: err.Error(), Icon: "svg:calculator",
				Source: "calc", Ephem: true, Error: true, Score: 1,
				Actions: []core.Action{{Type: core.ActionCopy, Title: "复制", Text: text, KeepOpen: true}},
			}}
		}
		return nil
	}
	var out []core.Item
	for i, r := range results {
		result := r.Text
		sub := text + " ="
		if r.Label != "" {
			sub = r.Label
		}
		out = append(out, core.Item{
			ID:       fmt.Sprintf("calc:%d", i),
			Title:    r.Text,
			Subtitle: sub,
			Icon:     "svg:calculator",
			Source:   "calc",
			Score:    0.99 - float64(i)*0.001,
			Ephem:    true,
			Actions: []core.Action{
				{Type: core.ActionFunc, Title: "复制结果", Fn: func(_ context.Context, run *core.Run) error {
					run.Host.CopyText(result)
					c.record(text, result)
					return nil
				}},
				// Ctrl+回车：带着算式进计算器页，可以接着算多行、翻历史。
				{Type: core.ActionView, Title: "在「计算器」面板中打开", Shortcut: "mod+enter", View: calcView(text)},
				{Type: core.ActionFunc, Title: "粘贴结果", Fn: func(_ context.Context, run *core.Run) error {
					run.Host.CopyText(result)
					c.record(text, result)
					run.Hide()
					if err := run.Host.PasteToFront(); err != nil {
						run.Host.Notify("已复制到剪贴板", "无法自动粘贴："+err.Error())
					}
					return nil
				}},
			},
		})
	}
	return out
}

func (c Calc) record(expr, result string) {
	if c.Record != nil {
		c.Record(expr, result)
	}
}

// calcView 是带着算式打开计算器页的视图。
func calcView(input string) *core.View {
	for _, d := range FeatureDefs() {
		if d.ID == "calc" {
			return FeatureView(d, input, nil)
		}
	}
	return nil
}

// CalcLine 是多行计算里一行的结果。
type CalcLine struct {
	Text  string `json:"text,omitempty"`  // 结果；空行和注释为空
	Error string `json:"error,omitempty"` // 这一行算不出来的原因
	Name  string `json:"name,omitempty"`  // 赋值行的变量名
}

var (
	assignRe     = regexp.MustCompile(`^([\p{L}_][\p{L}\p{N}_]*)\s*=\s*(.+)$`)
	calcReserved = map[string]bool{
		"pi": true, "e": true, "sqrt": true, "abs": true, "round": true, "floor": true, "ceil": true, "sin": true, "cos": true,
		"tan": true, "ln": true, "log": true, "exp": true, "pow": true, "min": true, "max": true, "to": true, "in": true,
	}
)

// EvaluateLines 逐行计算。每行是一个算式或单位换算，另外支持：
//
//	x = 3 * 4      给变量赋值，后面的行可以用
//	ans            上一行的结果
//	sum            前面所有行结果的和
//	# 或 //        注释
func EvaluateLines(lines []string) []CalcLine {
	out := make([]CalcLine, len(lines))
	vars := map[string]float64{}
	sum := 0.0
	for i, raw := range lines {
		line := raw
		for _, mark := range []string{"#", "//"} {
			if j := strings.Index(line, mark); j >= 0 {
				line = line[:j]
			}
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		name, expr := "", line
		if m := assignRe.FindStringSubmatch(line); m != nil {
			name, expr = strings.ToLower(m[1]), m[2]
			if calcReserved[name] || name == "ans" || name == "sum" {
				out[i].Error = "「" + m[1] + "」是保留的名字，换一个变量名"
				continue
			}
		}
		vars["sum"] = sum
		lower := strings.ToLower(strings.TrimSpace(expr))
		// 单位换算不涉及变量，原样交给它。
		if name == "" && parseConversion(lower) != nil {
			res, err := Evaluate(expr)
			if err != nil {
				out[i].Error = err.Error()
			} else if len(res) > 0 {
				out[i].Text = res[0].Text
			}
			continue
		}
		p := &calcParser{src: []rune(lower), vars: vars}
		v, err := p.expression()
		if err == nil {
			p.space()
			if p.pos < len(p.src) {
				err = fmt.Errorf("无法理解「%s」", string(p.src[p.pos:]))
			} else if math.IsNaN(v) || math.IsInf(v, 0) {
				err = errors.New("结果不是有限数")
			}
		}
		if err != nil {
			out[i].Error = err.Error()
			continue
		}
		out[i].Text, out[i].Name = formatNumber(v), name
		vars["ans"] = v
		if name != "" {
			vars[name] = v
		}
		// 单独一行 sum 是在看合计，它自己不再算进合计里。
		if lower != "sum" {
			sum += v
		}
	}
	return out
}

// CalcResult 是一个计算结果。
type CalcResult struct {
	Text  string
	Label string
}

// LooksLikeMath 判断无前缀输入是否像算式，避免普通文字被当成算式。
func LooksLikeMath(s string) bool {
	if !strings.ContainsFunc(s, unicode.IsDigit) && !strings.Contains(s, "pi") {
		return false
	}
	lower := strings.ToLower(s)
	if strings.HasPrefix(lower, "0x") || strings.HasPrefix(lower, "0b") || strings.HasPrefix(lower, "0o") {
		return true
	}
	if parseConversion(lower) != nil {
		return true
	}
	if strings.ContainsAny(s, "+*/^%()×÷") {
		return true
	}
	// 减号只算中间的（避免把 2026-11-06 这种当成算式之外，单个负数也不算）。
	if i := strings.LastIndex(s, "-"); i > 0 && strings.Count(s, "-") == 1 {
		return true
	}
	for _, fn := range []string{"sqrt", "sin", "cos", "tan", "log", "ln", "abs", "pow", "round", "floor", "ceil"} {
		if strings.HasPrefix(lower, fn+"(") {
			return true
		}
	}
	return false
}

// Evaluate 计算表达式或单位换算。
func Evaluate(text string) ([]CalcResult, error) {
	lower := strings.ToLower(strings.TrimSpace(text))
	if c := parseConversion(lower); c != nil {
		return c.run()
	}
	p := &calcParser{src: []rune(lower)}
	v, err := p.expression()
	if err != nil {
		return nil, err
	}
	p.space()
	if p.pos < len(p.src) {
		return nil, fmt.Errorf("无法理解「%s」", string(p.src[p.pos:]))
	}
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return nil, errors.New("结果不是有限数")
	}
	out := []CalcResult{{Text: formatNumber(v)}}
	if v == math.Trunc(v) && math.Abs(v) < 1<<53 && p.nonDecimal {
		n := int64(v)
		out = append(out,
			CalcResult{Text: "0x" + strconv.FormatInt(n, 16), Label: "十六进制"},
			CalcResult{Text: "0b" + strconv.FormatInt(n, 2), Label: "二进制"},
		)
	}
	return out, nil
}

// formatNumber 去掉浮点误差（0.1+0.2 显示 0.3）。
func formatNumber(v float64) string {
	if v == 0 {
		return "0"
	}
	if math.Abs(v) >= 1e15 || math.Abs(v) < 1e-9 {
		return strconv.FormatFloat(v, 'g', 12, 64)
	}
	s := strconv.FormatFloat(v, 'f', 10, 64)
	if strings.Contains(s, ".") {
		s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	}
	return s
}

type calcParser struct {
	src        []rune
	pos        int
	nonDecimal bool
	inCall     int // 在函数参数里时，逗号是参数分隔符而不是千分位
	vars       map[string]float64
}

func (p *calcParser) space() {
	for p.pos < len(p.src) && unicode.IsSpace(p.src[p.pos]) {
		p.pos++
	}
}

func (p *calcParser) peek() rune {
	p.space()
	if p.pos >= len(p.src) {
		return 0
	}
	return p.src[p.pos]
}

func (p *calcParser) expression() (float64, error) {
	v, err := p.term()
	if err != nil {
		return 0, err
	}
	for {
		switch p.peek() {
		case '+':
			p.pos++
			r, err := p.term()
			if err != nil {
				return 0, err
			}
			v += r
		case '-':
			p.pos++
			r, err := p.term()
			if err != nil {
				return 0, err
			}
			v -= r
		default:
			return v, nil
		}
	}
}

func (p *calcParser) term() (float64, error) {
	v, err := p.unary()
	if err != nil {
		return 0, err
	}
	for {
		switch p.peek() {
		case '*', '×':
			p.pos++
			r, err := p.unary()
			if err != nil {
				return 0, err
			}
			v *= r
		case '/', '÷':
			p.pos++
			r, err := p.unary()
			if err != nil {
				return 0, err
			}
			if r == 0 {
				return 0, errors.New("不能除以 0")
			}
			v /= r
		case '%':
			p.pos++
			// 结尾或后面跟运算符时是百分号，否则是取模。
			switch next := p.peek(); {
			case next == 0 || next == ')' || next == '+' || next == '-' || next == '*' || next == '/':
				v /= 100
			default:
				r, err := p.unary()
				if err != nil {
					return 0, err
				}
				if r == 0 {
					return 0, errors.New("不能对 0 取模")
				}
				v = math.Mod(v, r)
			}
		default:
			return v, nil
		}
	}
}

func (p *calcParser) unary() (float64, error) {
	switch p.peek() {
	case '-':
		p.pos++
		v, err := p.unary()
		return -v, err
	case '+':
		p.pos++
		return p.unary()
	}
	return p.power()
}

func (p *calcParser) power() (float64, error) {
	base, err := p.primary()
	if err != nil {
		return 0, err
	}
	if c := p.peek(); c == '^' || (c == '*' && p.pos+1 < len(p.src) && p.src[p.pos+1] == '*') {
		if c == '*' {
			p.pos++
		}
		p.pos++
		exp, err := p.unary()
		if err != nil {
			return 0, err
		}
		return math.Pow(base, exp), nil
	}
	return base, nil
}

func (p *calcParser) primary() (float64, error) {
	c := p.peek()
	switch {
	case c == 0:
		return 0, errors.New("算式不完整")
	case c == '(':
		p.pos++
		v, err := p.expression()
		if err != nil {
			return 0, err
		}
		if p.peek() != ')' {
			return 0, errors.New("缺少右括号")
		}
		p.pos++
		return v, nil
	case unicode.IsDigit(c) || c == '.':
		return p.number()
	case unicode.IsLetter(c):
		start := p.pos
		for p.pos < len(p.src) && (unicode.IsLetter(p.src[p.pos]) || unicode.IsDigit(p.src[p.pos]) || p.src[p.pos] == '_') {
			p.pos++
		}
		return p.call(string(p.src[start:p.pos]))
	}
	return 0, fmt.Errorf("无法理解「%c」", c)
}

func (p *calcParser) number() (float64, error) {
	start := p.pos
	if p.src[p.pos] == '0' && p.pos+1 < len(p.src) {
		base := 0
		switch p.src[p.pos+1] {
		case 'x':
			base = 16
		case 'b':
			base = 2
		case 'o':
			base = 8
		}
		if base != 0 {
			p.pos += 2
			digits := p.pos
			for p.pos < len(p.src) && (unicode.IsDigit(p.src[p.pos]) || (p.src[p.pos] >= 'a' && p.src[p.pos] <= 'f')) {
				p.pos++
			}
			n, err := strconv.ParseInt(string(p.src[digits:p.pos]), base, 64)
			if err != nil {
				return 0, errors.New("进制数写法有误")
			}
			p.nonDecimal = true
			return float64(n), nil
		}
	}
	for p.pos < len(p.src) {
		r := p.src[p.pos]
		if unicode.IsDigit(r) || r == '.' || (r == ',' && p.inCall == 0) {
			p.pos++
			continue
		}
		if r == 'e' && p.pos+1 < len(p.src) && (unicode.IsDigit(p.src[p.pos+1]) || p.src[p.pos+1] == '-' || p.src[p.pos+1] == '+') {
			p.pos += 2
			continue
		}
		break
	}
	s := strings.ReplaceAll(string(p.src[start:p.pos]), ",", "")
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, fmt.Errorf("数字写法有误：%s", s)
	}
	return v, nil
}

func (p *calcParser) call(name string) (float64, error) {
	switch name {
	case "pi":
		return math.Pi, nil
	case "e":
		return math.E, nil
	}
	if p.peek() != '(' {
		if v, ok := p.vars[name]; ok {
			return v, nil
		}
		return 0, fmt.Errorf("无法理解「%s」", name)
	}
	p.pos++
	p.inCall++
	defer func() { p.inCall-- }()
	var args []float64
	for {
		v, err := p.expression()
		if err != nil {
			return 0, err
		}
		args = append(args, v)
		c := p.peek()
		p.pos++
		if c == ')' {
			break
		}
		if c != ',' {
			return 0, errors.New("函数参数写法有误")
		}
	}
	one := map[string]func(float64) float64{
		"sqrt": math.Sqrt, "abs": math.Abs, "round": math.Round, "floor": math.Floor, "ceil": math.Ceil,
		"sin": math.Sin, "cos": math.Cos, "tan": math.Tan, "ln": math.Log, "log": math.Log10, "exp": math.Exp,
	}
	if fn, ok := one[name]; ok {
		if len(args) != 1 {
			return 0, fmt.Errorf("%s 需要 1 个参数", name)
		}
		return fn(args[0]), nil
	}
	switch name {
	case "pow":
		if len(args) != 2 {
			return 0, errors.New("pow 需要 2 个参数")
		}
		return math.Pow(args[0], args[1]), nil
	case "min":
		v := args[0]
		for _, a := range args {
			v = math.Min(v, a)
		}
		return v, nil
	case "max":
		v := args[0]
		for _, a := range args {
			v = math.Max(v, a)
		}
		return v, nil
	}
	return 0, fmt.Errorf("没有函数「%s」", name)
}

// 单位换算：同一组内的单位可以互转，值是换算到基准单位的系数。
var unitGroups = []map[string]float64{
	{"mm": 0.001, "cm": 0.01, "m": 1, "km": 1000, "in": 0.0254, "ft": 0.3048, "yd": 0.9144, "mi": 1609.344, "毫米": 0.001, "厘米": 0.01, "米": 1, "公里": 1000, "英寸": 0.0254, "英尺": 0.3048, "英里": 1609.344},
	{"mg": 1e-6, "g": 0.001, "kg": 1, "t": 1000, "oz": 0.0283495, "lb": 0.453592, "克": 0.001, "千克": 1, "公斤": 1, "斤": 0.5, "吨": 1000},
	{"b": 1, "kb": 1000, "mb": 1e6, "gb": 1e9, "tb": 1e12, "kib": 1024, "mib": 1 << 20, "gib": 1 << 30, "tib": 1 << 40},
	{"ms": 0.001, "s": 1, "sec": 1, "min": 60, "h": 3600, "hour": 3600, "d": 86400, "day": 86400, "w": 604800, "秒": 1, "分钟": 60, "小时": 3600, "天": 86400, "周": 604800},
}

type conversion struct {
	value    float64
	from, to string
}

// parseConversion 解析「10 km to mi」「100 f to c」「255 to hex」。
func parseConversion(s string) *conversion {
	var left, right string
	for _, sep := range []string{" to ", " in ", " 转 ", "=>"} {
		if l, r, ok := strings.Cut(s, sep); ok {
			left, right = strings.TrimSpace(l), strings.TrimSpace(r)
			break
		}
	}
	if left == "" || right == "" {
		return nil
	}
	i := strings.IndexFunc(left, func(r rune) bool {
		return !unicode.IsDigit(r) && r != '.' && r != '-' && r != 'x' && !(r >= 'a' && r <= 'f' && strings.HasPrefix(left, "0x"))
	})
	numPart, unit := left, ""
	if i >= 0 {
		numPart, unit = strings.TrimSpace(left[:i]), strings.TrimSpace(left[i:])
	}
	if numPart == "" {
		return nil
	}
	p := &calcParser{src: []rune(numPart)}
	v, err := p.expression()
	if err != nil {
		return nil
	}
	c := &conversion{value: v, from: unit, to: right}
	if c.valid() {
		return c
	}
	return nil
}

func (c *conversion) valid() bool {
	switch c.to {
	case "hex", "bin", "oct", "dec", "十六进制", "二进制", "八进制", "十进制":
		return c.from == ""
	}
	if tempUnit(c.from) != "" && tempUnit(c.to) != "" {
		return true
	}
	for _, g := range unitGroups {
		if _, ok := g[c.from]; ok {
			if _, ok := g[c.to]; ok {
				return true
			}
		}
	}
	return false
}

func tempUnit(s string) string {
	switch s {
	case "c", "°c", "摄氏度":
		return "c"
	case "f", "°f", "华氏度":
		return "f"
	case "k":
		return "k"
	}
	return ""
}

func (c *conversion) run() ([]CalcResult, error) {
	n := int64(c.value)
	switch c.to {
	case "hex", "十六进制":
		return []CalcResult{{Text: "0x" + strconv.FormatInt(n, 16)}}, nil
	case "bin", "二进制":
		return []CalcResult{{Text: "0b" + strconv.FormatInt(n, 2)}}, nil
	case "oct", "八进制":
		return []CalcResult{{Text: "0o" + strconv.FormatInt(n, 8)}}, nil
	case "dec", "十进制":
		return []CalcResult{{Text: strconv.FormatInt(n, 10)}}, nil
	}
	if from, to := tempUnit(c.from), tempUnit(c.to); from != "" && to != "" {
		k := c.value
		switch from {
		case "c":
			k = c.value + 273.15
		case "f":
			k = (c.value-32)*5/9 + 273.15
		}
		v := k
		switch to {
		case "c":
			v = k - 273.15
		case "f":
			v = (k-273.15)*9/5 + 32
		}
		return []CalcResult{{Text: formatNumber(v) + " " + c.to}}, nil
	}
	for _, g := range unitGroups {
		f, ok1 := g[c.from]
		t, ok2 := g[c.to]
		if ok1 && ok2 {
			return []CalcResult{{Text: formatNumber(c.value*f/t) + " " + c.to}}, nil
		}
	}
	return nil, errors.New("不支持这个换算")
}
