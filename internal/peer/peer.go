// Package peer implements an opt-in, IPv6-only file transfer session. No network
// listeners are created until the extension is opened. Pairing authenticates the
// TLS channel by a number compared out of band, before accepting any file data.
package peer

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"yojigen-pocket/internal/store"
)

const Port = 47831

var ErrBusy = errors.New("正在传输文件，请等待完成或先取消传输")

type Identity struct {
	Name   string `json:"name"`
	Avatar int    `json:"avatar"`
}
type Snapshot struct {
	Self        Identity       `json:"self"`
	Addresses   []string       `json:"addresses"`
	Port        int            `json:"port"`
	DirectReady bool           `json:"directReady"`
	Folder      string         `json:"folder"`
	State       string         `json:"state"`
	SessionMode string         `json:"sessionMode,omitempty"`
	Peer        *Identity      `json:"peer,omitempty"`
	Address     string         `json:"address,omitempty"`
	Code        string         `json:"code,omitempty"`
	Choices     []string       `json:"choices,omitempty"`
	Expires     int64          `json:"expires,omitempty"`
	Error       string         `json:"error,omitempty"`
	Busy        bool           `json:"busy"`
	Punch       *PunchSnapshot `json:"punch,omitempty"`
	Records     []Record       `json:"records"`
}
type Record struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Size      int64   `json:"size"`
	Done      int64   `json:"done"`
	Speed     float64 `json:"speed"`
	Direction string  `json:"direction"`
	Status    string  `json:"status"`
	Peer      string  `json:"peer"`
	Started   int64   `json:"started"`
	Finished  int64   `json:"finished,omitempty"`
	Path      string  `json:"path,omitempty"`
	Error     string  `json:"error,omitempty"`
	Temp      string  `json:"temp,omitempty"`
}
type Config struct{ DataDir, ReceiveDir string }
type Service struct {
	mu                         sync.Mutex
	self                       Identity
	addresses                  []string
	folder, dataDir, lastError string
	server                     *http.Server
	listener                   net.Listener
	punch                      *punchEngine
	current                    *session
	records                    []Record
	closed                     bool
	active                     int
	port                       int
	// Test-only settings, never set through the extension API.
	allowLocal  bool
	stunServers []string
}
type session struct {
	service                   *Service
	conn                      transportConn
	ctx                       context.Context
	cancel                    context.CancelFunc
	mu                        sync.Mutex // serializes protocol writes, not state (owned by service.mu)
	remote                    Identity
	mode                      string
	address, state, sas, code string
	choices                   []string
	incoming                  bool
	userCancelled             bool
	expires                   time.Time
	timer                     *time.Timer
	sending                   bool
	receive                   *incomingFile // owned exclusively by the reader goroutine
	ack                       chan message
	done                      chan struct{}
}
type message struct {
	Type     string   `json:"type"`
	Identity Identity `json:"identity,omitempty"`
	Auth     string   `json:"auth,omitempty"`
	ID       string   `json:"id,omitempty"`
	Name     string   `json:"name,omitempty"`
	Size     int64    `json:"size,omitempty"`
	Hash     string   `json:"hash,omitempty"`
	Error    string   `json:"error,omitempty"`
}

func randomID() string { b := make([]byte, 16); _, _ = rand.Read(b); return hex.EncodeToString(b) }
func randomN(n int) int {
	v, err := rand.Int(rand.Reader, big.NewInt(int64(n)))
	if err != nil {
		panic(err)
	}
	return int(v.Int64())
}
func newIdentity() Identity {
	a := []string{"晴空", "薄荷", "星河", "橘子", "月光", "山岚", "海盐", "奶油"}
	b := []string{"水獭", "狐狸", "鲸鱼", "企鹅", "松鼠", "小熊", "海豹", "猫咪"}
	i := randomN(len(b))
	return Identity{fmt.Sprintf("%s%s %02d", a[randomN(len(a))], b[i], randomN(100)), i}
}
func New(cfg Config) (*Service, error) { return newService(cfg, false, Port) }
func newService(cfg Config, local bool, port int) (*Service, error) {
	if err := os.MkdirAll(cfg.DataDir, 0700); err != nil {
		return nil, err
	}
	s := &Service{self: newIdentity(), addresses: Addresses(), folder: cfg.ReceiveDir, dataDir: cfg.DataDir, port: port, allowLocal: local, records: []Record{}}
	var saved struct {
		Folder  string   `json:"folder"`
		Records []Record `json:"records"`
	}
	if raw, err := os.ReadFile(filepath.Join(cfg.DataDir, "transfers.json")); err == nil {
		if err = json.Unmarshal(raw, &saved); err != nil {
			return nil, fmt.Errorf("传输记录无法读取：%w", err)
		}
		if saved.Folder != "" {
			s.folder = saved.Folder
		}
		s.records = saved.Records
	}
	if s.records == nil {
		s.records = []Record{}
	}
	for i := range s.records {
		r := &s.records[i]
		if r.Status == "transferring" || r.Status == "queued" || r.Status == "verifying" {
			r.Status = "interrupted"
			r.Error = "上次传输未完成，请重新发送"
			r.Speed = 0
			r.Finished = time.Now().UnixMilli()
			if r.Temp != "" && strings.HasPrefix(filepath.Base(r.Temp), ".pocket-") {
				_ = os.Remove(r.Temp)
			}
			r.Temp = ""
		}
	}
	if err := s.saveLocked(); err != nil {
		return nil, err
	}
	return s, nil
}
func (s *Service) Start() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("传输服务已关闭，请重新打开扩展")
	}
	s.addresses = Addresses()
	if s.listener != nil {
		return nil
	}
	if !s.allowLocal && len(s.addresses) == 0 {
		return errors.New("未检测到公网 IPv6 地址，请检查网络后刷新")
	}
	cert, err := certificate()
	if err != nil {
		return err
	}
	ln, err := net.Listen("tcp6", fmt.Sprintf("[::]:%d", s.port))
	if err != nil {
		return fmt.Errorf("IPv6 端口 %d 无法监听：%w", s.port, err)
	}
	s.port = ln.Addr().(*net.TCPAddr).Port
	s.listener = ln
	s.server = &http.Server{Handler: http.HandlerFunc(s.accept), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second, TLSConfig: &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS13}}
	go func() { _ = s.server.ServeTLS(ln, "", "") }()
	return nil
}
func certificate() (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, err
	}
	t := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "Pocket Peer"}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(24 * time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, t, t, &key.PublicKey, key)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, err
}
func channelNumber(state *tls.ConnectionState) (string, error) {
	b, err := state.ExportKeyingMaterial("pocket-peer-number-v1", nil, 8)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%02d", binary.BigEndian.Uint64(b)%90+10), nil
}
func (s *Service) Snapshot() Snapshot {
	s.mu.Lock()
	v := Snapshot{Self: s.self, Addresses: append([]string{}, s.addresses...), Port: s.port, DirectReady: s.listener != nil, Folder: s.folder, State: "idle", Error: s.lastError, Busy: s.active > 0, Records: append([]Record{}, s.records...)}
	for i := range v.Records {
		v.Records[i].Temp = ""
	}
	if s.listener == nil {
		v.State = "offline"
	}
	if p := s.current; p != nil {
		v.State = p.state
		v.SessionMode = p.mode
		peer := p.remote
		v.Peer = &peer
		v.Address = p.address
		v.Code = p.code
		v.Choices = append([]string{}, p.choices...)
		if !p.expires.IsZero() {
			v.Expires = p.expires.UnixMilli()
		}
	}
	punch := s.punch
	s.mu.Unlock()
	if punch != nil {
		v.Punch = punch.snapshot()
		if v.State == "offline" && v.Punch.Ready {
			v.State = "idle"
		}
	}
	return v
}
func (s *Service) Busy() bool { s.mu.Lock(); defer s.mu.Unlock(); return s.active > 0 }
func (s *Service) SetFolder(dir string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active > 0 {
		return ErrBusy
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return errors.New("请选择可用的接收文件夹")
	}
	old := s.folder
	s.folder = dir
	if err = s.saveLocked(); err != nil {
		s.folder = old
		return err
	}
	return nil
}
// ClearHistory 删除已结束的传输记录（完成、失败、中断），进行中的任务保留。返回删除的条数。
func (s *Service) ClearHistory() (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	old := s.records
	kept := make([]Record, 0, len(old))
	for _, r := range old {
		if r.Status == "queued" || r.Status == "transferring" || r.Status == "verifying" {
			kept = append(kept, r)
		}
	}
	s.records = kept
	if err := s.saveLocked(); err != nil {
		s.records = old
		return 0, err
	}
	return len(old) - len(kept), nil
}

// RemoveRecord 删除一条已结束的传输记录（不删除已接收的文件）。
func (s *Service) RemoveRecord(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, r := range s.records {
		if r.ID != id {
			continue
		}
		if r.Status == "queued" || r.Status == "transferring" || r.Status == "verifying" {
			return errors.New("传输进行中，不能删除这条记录")
		}
		old := s.records
		s.records = append(append([]Record{}, old[:i]...), old[i+1:]...)
		if err := s.saveLocked(); err != nil {
			s.records = old
			return err
		}
		return nil
	}
	return errors.New("找不到这条记录")
}

func (s *Service) saveLocked() error {
	raw, err := json.Marshal(struct {
		Folder  string   `json:"folder"`
		Records []Record `json:"records"`
	}{s.folder, s.records})
	if err != nil {
		return err
	}
	return store.WriteFileAtomic(filepath.Join(s.dataDir, "transfers.json"), raw)
}
func (s *Service) TryClose() error {
	s.mu.Lock()
	if s.active > 0 {
		s.mu.Unlock()
		return ErrBusy
	}
	s.closed = true
	p, server, punch := s.current, s.server, s.punch
	s.punch = nil
	if p != nil {
		p.cancel()
	}
	s.mu.Unlock()
	if p != nil {
		p.closeConnection()
	}
	if punch != nil {
		_ = punch.Close()
	}
	if server != nil {
		_ = server.Close()
	}
	return nil
}
func (s *Service) Disconnect() error {
	s.mu.Lock()
	if s.active > 0 {
		s.mu.Unlock()
		return ErrBusy
	}
	p := s.current
	if p != nil {
		p.userCancelled = true
		p.cancel()
	}
	s.mu.Unlock()
	if p != nil {
		p.closeConnection()
	}
	return nil
}
func (s *Service) Cancel() {
	s.mu.Lock()
	p := s.current
	if p != nil {
		p.userCancelled = true
		p.cancel()
	}
	s.mu.Unlock()
	if p != nil {
		p.closeConnection()
	}
}
func (p *session) attach(conn transportConn) {
	p.service.mu.Lock()
	p.conn = conn
	cancelled := p.ctx.Err() != nil
	p.service.mu.Unlock()
	if cancelled {
		_ = conn.CloseNow()
	}
}
func (p *session) closeConnection() {
	p.service.mu.Lock()
	conn := p.conn
	p.service.mu.Unlock()
	if conn != nil {
		_ = conn.CloseNow()
	}
}
func (s *Service) makeSession(incoming bool, address string) (*session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.current != nil || s.active > 0 {
		return nil, errors.New("已有连接或请求，请先断开")
	}
	ctx, cancel := context.WithCancel(context.Background())
	p := &session{service: s, ctx: ctx, cancel: cancel, incoming: incoming, mode: "direct", address: address, state: "connecting", ack: make(chan message, 4), done: make(chan struct{})}
	s.current = p
	s.lastError = ""
	return p, nil
}
func (p *session) write(m message) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return p.writeBytes(websocket.MessageText, b)
}
func (p *session) writeBytes(kind websocket.MessageType, b []byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.writeBytesLocked(kind, b)
}
func (p *session) writeControlLocked(m message) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return p.writeBytesLocked(websocket.MessageText, b)
}
func (p *session) writeBytesLocked(kind websocket.MessageType, b []byte) error {
	ctx, cancel := context.WithTimeout(p.ctx, 30*time.Second)
	defer cancel()
	return p.conn.WriteMessage(ctx, kind, b)
}
func (p *session) deadline() {
	s := p.service
	s.mu.Lock()
	defer s.mu.Unlock()
	p.expires = time.Now().Add(2 * time.Minute)
	p.timer = time.AfterFunc(2*time.Minute, func() {
		s.mu.Lock()
		expired := s.current == p && p.state != "connected"
		if expired {
			s.lastError = "连接确认已超时，请重新发起"
		}
		s.mu.Unlock()
		if expired {
			p.cancel()
			_ = p.conn.CloseNow()
		}
	})
}
func (p *session) finish(err error) {
	p.cancel()
	if p.conn != nil {
		_ = p.conn.CloseNow()
	}
	if p.receive != nil {
		p.abortReceive("连接中断，文件未完成")
	}
	s := p.service
	s.mu.Lock()
	if p.timer != nil {
		p.timer.Stop()
	}
	if s.current == p {
		s.current = nil
		if err != nil && s.lastError == "" {
			s.lastError = "连接已断开：" + err.Error()
		}
	}
	s.mu.Unlock()
	close(p.done)
}
func (s *Service) accept(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/pocket/v1" || r.Header.Get("Origin") != "" || r.TLS == nil {
		http.Error(w, "not found", 404)
		return
	}
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	ip, err := netip.ParseAddr(host)
	if err != nil || (!s.allowLocal && !publicIPv6(ip)) {
		http.Error(w, "IPv6 required", 403)
		return
	}
	p, err := s.makeSession(true, host)
	if err != nil {
		http.Error(w, "busy", 409)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"pocket-peer-v1"}})
	if err != nil {
		p.finish(err)
		return
	}
	tc := newWSTransport(conn, r.TLS)
	p.attach(tc)
	sas, err := channelNumber(tc.TLSState())
	if err != nil {
		p.finish(err)
		return
	}
	p.sas = sas
	ctx, cancel := context.WithTimeout(p.ctx, 10*time.Second)
	_, raw, err := tc.ReadMessage(ctx)
	cancel()
	var hello message
	if err != nil || unmarshalHello(raw, &hello) != nil {
		p.finish(errors.New("无效连接请求"))
		return
	}
	s.mu.Lock()
	p.remote = hello.Identity
	s.mu.Unlock()
	p.deadline()
	if err = p.write(message{Type: "waiting", Identity: s.self}); err != nil {
		p.finish(err)
		return
	}
	s.mu.Lock()
	p.state = "request"
	s.mu.Unlock()
	p.readLoop()
}
func unmarshalHello(raw []byte, out *message) error {
	if len(raw) > 16<<10 || json.Unmarshal(raw, out) != nil || out.Type != "hello" || !validIdentity(out.Identity) {
		return errors.New("无效连接请求")
	}
	return nil
}

func validIdentity(i Identity) bool {
	return len([]rune(i.Name)) > 0 && len([]rune(i.Name)) <= 32 && !strings.ContainsAny(i.Name, "\r\n\x00") && i.Avatar >= 0 && i.Avatar < 8
}
func (s *Service) Connect(address string) error { return s.connectTo(address, Port) }

func (s *Service) connectTo(address string, targetPort int) error {
	if err := s.Start(); err != nil {
		return err
	}
	ip, err := netip.ParseAddr(strings.Trim(strings.TrimSpace(address), "[]"))
	if err != nil || (!s.allowLocal && !publicIPv6(ip)) || !ip.Is6() || ip.Is4In6() || ip.Zone() != "" {
		return errors.New("请输入对方的公网 IPv6 地址，不含端口")
	}
	p, err := s.makeSession(false, ip.String())
	if err != nil {
		return err
	}
	go func() {
		// Initial certificate trust is established by comparing the TLS exporter
		// number. No files may be exchanged before that comparison succeeds.
		transport := &http.Transport{Proxy: nil, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, InsecureSkipVerify: true}}
		defer transport.CloseIdleConnections()
		ctx, cancel := context.WithTimeout(p.ctx, 10*time.Second)
		conn, response, err := websocket.Dial(ctx, "wss://"+net.JoinHostPort(ip.String(), fmt.Sprint(targetPort))+"/pocket/v1", &websocket.DialOptions{HTTPClient: &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("不允许重定向") }}, Subprotocols: []string{"pocket-peer-v1"}})
		cancel()
		if err != nil {
			p.finish(fmt.Errorf("无法连接，请检查对方扩展和 IPv6 防火墙：%w", err))
			return
		}
		tc := newWSTransport(conn, response.TLS)
		p.attach(tc)
		p.sas, err = channelNumber(tc.TLSState())
		if err != nil {
			p.finish(err)
			return
		}
		p.deadline()
		if err = p.write(message{Type: "hello", Identity: s.self}); err != nil {
			p.finish(err)
			return
		}
		p.readLoop()
	}()
	return nil
}
func (s *Service) Accept() error {
	s.mu.Lock()
	p := s.current
	s.mu.Unlock()
	if p == nil {
		return errors.New("请求已失效")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	s.mu.Lock()
	if s.current != p || !p.incoming || p.state != "request" || time.Now().After(p.expires) {
		s.mu.Unlock()
		return errors.New("请求已失效")
	}
	p.choices = []string{p.sas}
	for len(p.choices) < 3 {
		n := fmt.Sprintf("%02d", randomN(90)+10)
		if n != p.choices[0] && (len(p.choices) == 1 || n != p.choices[1]) {
			p.choices = append(p.choices, n)
		}
	}
	for i := 2; i > 0; i-- {
		j := randomN(i + 1)
		p.choices[i], p.choices[j] = p.choices[j], p.choices[i]
	}
	p.state = "verify"
	s.mu.Unlock()
	return p.writeControlLocked(message{Type: "challenge"})
}
func (s *Service) Confirm(number string) error {
	s.mu.Lock()
	p := s.current
	s.mu.Unlock()
	if p == nil {
		return errors.New("验证已失效")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	s.mu.Lock()
	if s.current != p || !p.incoming || p.state != "verify" || time.Now().After(p.expires) {
		s.mu.Unlock()
		return errors.New("验证已失效")
	}
	if number != p.sas {
		s.lastError = "数字不匹配，连接已拒绝"
		s.mu.Unlock()
		_ = p.writeControlLocked(message{Type: "rejected", Error: "数字不匹配，连接已拒绝"})
		p.cancel()
		_ = p.conn.CloseNow()
		return errors.New("数字不匹配，连接已拒绝")
	}
	p.state = "connected"
	p.choices = nil
	p.expires = time.Time{}
	if p.timer != nil {
		p.timer.Stop()
	}
	s.mu.Unlock()
	return p.writeControlLocked(message{Type: "ready"})
}
func (s *Service) Reject() error {
	s.mu.Lock()
	p := s.current
	if p == nil || !p.incoming || (p.state != "request" && p.state != "verify") {
		s.mu.Unlock()
		return errors.New("请求已失效")
	}
	s.mu.Unlock()
	_ = p.write(message{Type: "rejected", Error: "对方拒绝了连接"})
	p.cancel()
	p.closeConnection()
	return nil
}
func (p *session) readLoop() {
	var end error
	defer func() { p.finish(end) }()
	// Ping detects a broken link even when both sides are idle.
	go func() {
		t := time.NewTicker(15 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-p.ctx.Done():
				return
			case <-t.C:
				ctx, cancel := context.WithTimeout(p.ctx, 10*time.Second)
				err := p.conn.Ping(ctx)
				cancel()
				if err != nil {
					p.cancel()
					_ = p.conn.CloseNow()
					return
				}
			}
		}
	}()
	for {
		kind, data, err := p.conn.ReadMessage(p.ctx)
		if err != nil {
			end = err
			return
		}
		if kind == websocket.MessageBinary {
			if err = p.receiveChunk(data); err != nil {
				end = err
				return
			}
			continue
		}
		var m message
		if len(data) > 16<<10 || json.Unmarshal(data, &m) != nil {
			end = errors.New("无效协议消息")
			return
		}
		s := p.service
		s.mu.Lock()
		state := p.state
		s.mu.Unlock()
		switch m.Type {
		case "waiting":
			if p.incoming || state != "connecting" || !validIdentity(m.Identity) {
				end = errors.New("无效握手")
				return
			}
			s.mu.Lock()
			p.remote = m.Identity
			p.state = "waiting"
			s.mu.Unlock()
		case "challenge":
			if p.incoming || state != "waiting" {
				end = errors.New("无效验证")
				return
			}
			s.mu.Lock()
			p.state = "verify"
			p.code = p.sas
			s.mu.Unlock()
		case "ready":
			if p.incoming || state != "verify" {
				end = errors.New("尚未验证")
				return
			}
			s.mu.Lock()
			p.state = "connected"
			p.code = ""
			p.expires = time.Time{}
			if p.timer != nil {
				p.timer.Stop()
			}
			s.mu.Unlock()
		case "rejected":
			end = errors.New("对方拒绝了连接或数字不匹配")
			return
		case "file":
			if state != "connected" {
				end = errors.New("尚未验证，拒绝文件")
				return
			}
			if err = p.beginReceive(m); err != nil {
				end = err
				return
			}
		case "file-end":
			if state != "connected" {
				end = errors.New("尚未验证")
				return
			}
			if err = p.endReceive(m); err != nil {
				end = err
				return
			}
		case "file-ready", "file-done", "file-error":
			if state != "connected" {
				end = errors.New("尚未验证")
				return
			}
			select {
			case p.ack <- m:
			default:
				end = errors.New("无效文件确认")
				return
			}
		default:
			end = errors.New("不支持的协议消息")
			return
		}
	}
}
