package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"yojigen-pocket/internal/platform"
	"yojigen-pocket/internal/providers"
)

// 扩展自带的后端程序。宿主把它拉起来，通过标准输入输出说话，一行一条 JSON：
//
//	宿主 → 程序   {"id": 1, "method": "search", "params": ["关键词"]}
//	程序 → 宿主   {"id": 1, "result": ...}   或   {"id": 1, "error": "出了什么问题"}
//	程序 → 宿主   {"event": "progress", "data": ...}     （不带 id：主动推给页面的消息）
//
// 两种生命周期：oneshot 每次调用起一个进程，答完就退，平时不占任何资源；
// on-demand 第一次调用时拉起，之后留着接着用，闲置一阵（默认 5 分钟）自动关掉。
// 扩展被停用、卸载或应用退出时，进程一定会被结束。

type rpcReply struct {
	ID     int64           `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
	Event  string          `json:"event"`
	Data   json.RawMessage `json:"data"`
}

type backendProc struct {
	id      string
	onEvent func(name string, data json.RawMessage)

	mu      sync.Mutex
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	seq     int64
	pending map[int64]chan rpcReply
	idle    *time.Timer
	cancel  context.CancelFunc
	dead    bool
}

// backendCommand 找出这个系统上的启动命令。第一个词在扩展目录里有就用那个文件，否则当成 PATH 里的程序。
func backendCommand(dir string, b *providers.BackendDef) ([]string, error) {
	cmd := b.Commands[runtime.GOOS]
	if len(cmd) == 0 {
		cmd = b.Command
	}
	if len(cmd) == 0 {
		return nil, fmt.Errorf("这个扩展没有提供 %s 上的后端程序", runtime.GOOS)
	}
	out := append([]string{}, cmd...)
	local := filepath.Join(dir, filepath.FromSlash(out[0]))
	if rel, err := filepath.Rel(dir, local); err == nil && !strings.HasPrefix(rel, "..") {
		if info, err := os.Stat(local); err == nil && !info.IsDir() {
			out[0] = local
			return out, nil
		}
	}
	p, err := exec.LookPath(out[0])
	if err != nil {
		return nil, fmt.Errorf("找不到后端程序「%s」", out[0])
	}
	out[0] = p
	return out, nil
}

func (h *pluginHost) spawn(id, dir string, b *providers.BackendDef) (*backendProc, error) {
	args, err := backendCommand(dir, b)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	cmd := platform.Command(ctx, args[0], args[1:]...)
	cmd.Dir = dir
	data := filepath.Join(h.a.paths.Data, "plugins", id+"-files")
	_ = os.MkdirAll(data, 0o755)
	cmd.Env = append(os.Environ(), "POCKET_PLUGIN_ID="+id, "POCKET_PLUGIN_DIR="+dir, "POCKET_DATA_DIR="+data)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		cancel()
		return nil, fmt.Errorf("后端程序启动失败：%v", err)
	}
	p := &backendProc{id: id, cmd: cmd, stdin: stdin, pending: map[int64]chan rpcReply{}, cancel: cancel}
	p.onEvent = func(name string, payload json.RawMessage) {
		PluginEvent.Broadcast(PluginEventData{Plugin: id, Name: "backend", Data: map[string]any{"event": name, "data": payload}})
	}
	go func() {
		sc := bufio.NewScanner(stderr)
		for sc.Scan() {
			log.Printf("扩展 %s 的后端：%s", id, sc.Text())
		}
	}()
	go func() {
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 64<<10), 32<<20)
		for sc.Scan() {
			var r rpcReply
			if json.Unmarshal(sc.Bytes(), &r) != nil {
				continue // 不是协议里的行（调试输出之类）：忽略
			}
			if r.Event != "" {
				p.onEvent(r.Event, r.Data)
				continue
			}
			p.mu.Lock()
			ch := p.pending[r.ID]
			delete(p.pending, r.ID)
			p.mu.Unlock()
			if ch != nil {
				ch <- r
			}
		}
		// 进程没了：还在等的调用都给个交代。
		_ = cmd.Wait()
		p.mu.Lock()
		p.dead = true
		for id, ch := range p.pending {
			ch <- rpcReply{ID: id, Error: "后端程序退出了"}
			delete(p.pending, id)
		}
		p.mu.Unlock()
		cancel()
	}()
	return p, nil
}

func (p *backendProc) stop() {
	p.mu.Lock()
	if p.idle != nil {
		p.idle.Stop()
	}
	stdin := p.stdin
	p.mu.Unlock()
	_ = stdin.Close() // 先关输入，给它机会自己收尾
	done := make(chan struct{})
	go func() {
		_ = p.cmd.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(800 * time.Millisecond):
	}
	p.cancel()
}

func (p *backendProc) call(ctx context.Context, method string, params []any) (json.RawMessage, error) {
	p.mu.Lock()
	if p.dead {
		p.mu.Unlock()
		return nil, errors.New("后端程序退出了")
	}
	p.seq++
	id := p.seq
	ch := make(chan rpcReply, 1)
	p.pending[id] = ch
	if params == nil {
		params = []any{}
	}
	line, err := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	if err == nil {
		_, err = p.stdin.Write(append(line, '\n'))
	}
	p.mu.Unlock()
	if err != nil {
		return nil, fmt.Errorf("没能把请求交给后端程序：%v", err)
	}
	select {
	case r := <-ch:
		if r.Error != "" {
			return nil, errors.New(r.Error)
		}
		return r.Result, nil
	case <-ctx.Done():
		p.mu.Lock()
		delete(p.pending, id)
		p.mu.Unlock()
		return nil, errors.New("后端程序没有在规定时间内回答")
	}
}

// backendCall 调扩展的后端程序。
func (h *pluginHost) backendCall(ctx context.Context, id, dir string, m providers.Manifest, method string, params []any) (any, error) {
	b := m.Backend
	if b == nil {
		return nil, errors.New("这个扩展没有后端程序")
	}
	if method == "" {
		return nil, errors.New("没有指定要调用的方法")
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	if b.Mode == "oneshot" {
		p, err := h.spawn(id, dir, b)
		if err != nil {
			return nil, err
		}
		defer p.stop()
		raw, err := p.call(ctx, method, params)
		if err != nil {
			return nil, err
		}
		return decodeResult(raw)
	}

	h.mu.Lock()
	p := h.backs[id]
	h.mu.Unlock()
	if p != nil {
		p.mu.Lock()
		dead := p.dead
		p.mu.Unlock()
		if dead {
			p = nil
		}
	}
	if p == nil {
		var err error
		if p, err = h.spawn(id, dir, b); err != nil {
			return nil, err
		}
		h.mu.Lock()
		if old := h.backs[id]; old != nil && old != p {
			go old.stop()
		}
		h.backs[id] = p
		h.mu.Unlock()
	}
	// 每次调用都把“闲置多久关掉”的计时重新开始。
	idle := time.Duration(b.Idle) * time.Second
	if idle <= 0 {
		idle = 5 * time.Minute
	}
	p.mu.Lock()
	if p.idle != nil {
		p.idle.Stop()
	}
	proc := p
	p.idle = time.AfterFunc(idle, func() {
		h.mu.Lock()
		if h.backs[id] == proc {
			delete(h.backs, id)
		}
		h.mu.Unlock()
		proc.stop()
	})
	p.mu.Unlock()
	raw, err := p.call(ctx, method, params)
	if err != nil {
		return nil, err
	}
	return decodeResult(raw)
}

func decodeResult(raw json.RawMessage) (any, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, errors.New("后端程序返回的不是合法的 JSON")
	}
	return v, nil
}

// backendRunning 报告一个扩展的后端进程是不是正开着（测试和道具库用）。
func (h *pluginHost) backendRunning(id string) bool {
	h.mu.Lock()
	p := h.backs[id]
	h.mu.Unlock()
	if p == nil {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return !p.dead
}
