package peer

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strings"
	"sync"
	"time"

	"github.com/pion/stun/v3"
	"github.com/quic-go/quic-go"
)

const (
	punchMagicByte   byte = 0x28 // top two bits are 00 so quic.Transport routes to ReadNonQUICPacket
	punchMsgPing     byte = 1
	punchMsgPong     byte = 2
	punchPacketSize       = 50
	punchWindow           = 60 * time.Second
	punchALPN             = "pocket-peer-quic-v1"
)

type PunchSnapshot struct {
	Ready      bool     `json:"ready"`
	Preparing  bool     `json:"preparing"`
	Token      string   `json:"token,omitempty"`
	Encrypted  bool     `json:"encrypted"`
	NATType    string   `json:"natType,omitempty"`
	Port       int      `json:"port,omitempty"`
	Candidates []string `json:"candidates,omitempty"`
	STUNError  string   `json:"stunError,omitempty"`
	Error      string   `json:"error,omitempty"`
}

type punchEngine struct {
	service *Service
	udpConn net.PacketConn
	tr      *quic.Transport
	ln      *quic.Listener
	stun    *stunDispatcher
	ctx     context.Context
	cancel  context.CancelFunc

	mu         sync.Mutex
	pin        string
	stunServer string
	preparing  bool
	localPort  int
	natType    uint8
	stunAddr   netip.AddrPort
	stunNote   string
	lastErr    string
	selfToken  PunchToken
	tokenStr   string
	candLabels []string
	active     *activePunch
}

type confirmedEndpoint struct {
	addr netip.AddrPort
	kind uint8
}

type activePunch struct {
	pairKey     [32]byte
	selfSeed    uint64
	peerToken   PunchToken
	dialer      bool
	ctx         context.Context
	cancel      context.CancelFunc
	confirmedCh chan confirmedEndpoint

	mu      sync.Mutex
	dynamic map[netip.AddrPort]struct{}
	pongs   map[netip.AddrPort]struct{}
}

func newPunchEngine(s *Service, pin, stunServer string) (*punchEngine, error) {
	bindAddr := ":0"
	if s.allowLocal {
		bindAddr = "[::1]:0"
	}
	conn, err := net.ListenPacket("udp", bindAddr)
	if err != nil && !s.allowLocal {
		conn, err = net.ListenPacket("udp4", ":0")
	}
	if err != nil {
		return nil, fmt.Errorf("UDP 打洞端口无法监听：%w", err)
	}
	udpAddr, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok || udpAddr.Port == 0 {
		_ = conn.Close()
		return nil, errors.New("无法获取本地 UDP 端口")
	}
	cert, err := certificate()
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	tr := &quic.Transport{Conn: conn}
	tlsCfg := &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS13,
		NextProtos:   []string{punchALPN},
	}
	ln, err := tr.Listen(tlsCfg, quicConfig())
	if err != nil {
		_ = tr.Close()
		_ = conn.Close()
		return nil, fmt.Errorf("QUIC 监听无法启动：%w", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	e := &punchEngine{
		service:    s,
		udpConn:    conn,
		tr:         tr,
		ln:         ln,
		stun:       newSTUNDispatcher(),
		ctx:        ctx,
		cancel:     cancel,
		pin:        strings.TrimSpace(pin),
		stunServer: strings.TrimSpace(stunServer),
		localPort:  udpAddr.Port,
	}
	e.selfToken.Version = punchTokenVersion
	if err = fillRandomTokenIdentity(&e.selfToken); err != nil {
		_ = e.Close()
		return nil, err
	}
	go e.readNonQUICLoop()
	return e, nil
}

func fillRandomTokenIdentity(t *PunchToken) error {
	var seedBuf [8]byte
	if _, err := rand.Read(seedBuf[:]); err != nil {
		return err
	}
	t.RoleSeed = binary.BigEndian.Uint64(seedBuf[:])
	if _, err := rand.Read(t.SessionToken[:]); err != nil {
		return err
	}
	return nil
}

func quicConfig() *quic.Config {
	return &quic.Config{
		HandshakeIdleTimeout: 10 * time.Second,
		MaxIdleTimeout:       45 * time.Second,
		KeepAlivePeriod:      15 * time.Second,
	}
}

func (e *punchEngine) Close() error {
	e.cancel()
	e.mu.Lock()
	ap := e.active
	e.active = nil
	e.mu.Unlock()
	if ap != nil {
		ap.cancel()
	}
	if e.ln != nil {
		_ = e.ln.Close()
	}
	if e.tr != nil {
		_ = e.tr.Close()
	}
	if e.udpConn != nil {
		_ = e.udpConn.Close()
	}
	return nil
}

func (e *punchEngine) readNonQUICLoop() {
	buf := make([]byte, 2048)
	for {
		n, raddr, err := e.tr.ReadNonQUICPacket(e.ctx, buf)
		if err != nil {
			return
		}
		pkt := buf[:n]
		if stun.IsMessage(pkt) {
			e.stun.handlePacket(pkt)
			continue
		}
		if len(pkt) == punchPacketSize && pkt[0] == punchMagicByte {
			if ua, ok := raddr.(*net.UDPAddr); ok {
				e.handlePunchPacket(pkt, ua)
			}
		}
	}
}

func (e *punchEngine) gatherSTUN() {
	var servers []string
	e.mu.Lock()
	custom := e.stunServer
	e.mu.Unlock()
	if custom != "" {
		servers = []string{custom}
	} else {
		servers = append([]string(nil), e.service.stunServers...)
	}
	res := e.stun.probe(e.ctx, e.tr, servers)
	e.mu.Lock()
	e.stunAddr = res.addr
	e.natType = res.natType
	e.stunNote = res.errNote
	e.preparing = false
	e.mu.Unlock()
	e.rebuildToken()
}

func (e *punchEngine) setPIN(pin string) {
	e.mu.Lock()
	e.pin = strings.TrimSpace(pin)
	e.mu.Unlock()
	e.rebuildToken()
}

func (e *punchEngine) rebuildToken() {
	e.mu.Lock()
	port := uint16(e.localPort)
	stunAddr := e.stunAddr
	nat := e.natType
	pin := e.pin
	allowLocal := e.service.allowLocal
	e.mu.Unlock()

	var cands []PunchCandidate
	var labels []string
	if allowLocal {
		cands = append(cands, PunchCandidate{Kind: candIPv6, Addr: netip.AddrPortFrom(netip.IPv6Loopback(), port)})
		labels = append(labels, fmt.Sprintf("回环测试 · [::1]:%d", port))
	} else {
		v6s := Addresses()
		for i, s := range v6s {
			if i >= 2 {
				break
			}
			if ip, err := netip.ParseAddr(s); err == nil {
				cands = append(cands, PunchCandidate{Kind: candIPv6, Addr: netip.AddrPortFrom(ip, port)})
				labels = append(labels, fmt.Sprintf("公网 IPv6 · [%s]:%d", ip, port))
			}
		}
		if stunAddr.IsValid() {
			cands = append(cands, PunchCandidate{Kind: candSTUNv4, Addr: stunAddr})
			labels = append(labels, fmt.Sprintf("公网 IPv4 (STUN) · %s", stunAddr))
		}
		v4s := localIPv4s()
		for i, ip := range v4s {
			if i >= 2 {
				break
			}
			ap := netip.AddrPortFrom(ip, port)
			cands = append(cands, PunchCandidate{Kind: candLANv4, Addr: ap})
			labels = append(labels, fmt.Sprintf("局域网 · %s", ap))
		}
	}

	e.mu.Lock()
	defer e.mu.Unlock()
	e.selfToken.NATType = nat
	e.selfToken.Candidates = cands
	e.candLabels = labels
	if len(cands) == 0 {
		e.tokenStr = ""
		e.lastErr = "未检测到可用网络地址，请检查网络连接后重试"
		return
	}
	encoded, err := EncodePunchToken(e.selfToken, pin)
	if err != nil {
		e.tokenStr = ""
		e.lastErr = err.Error()
		return
	}
	e.tokenStr = encoded
	e.lastErr = ""
}

func (e *punchEngine) snapshot() *PunchSnapshot {
	e.mu.Lock()
	defer e.mu.Unlock()
	return &PunchSnapshot{
		Ready:      e.tokenStr != "",
		Preparing:  e.preparing,
		Token:      e.tokenStr,
		Encrypted:  e.pin != "",
		NATType:    natTypeString(e.natType),
		Port:       e.localPort,
		Candidates: append([]string{}, e.candLabels...),
		STUNError:  e.stunNote,
		Error:      e.lastErr,
	}
}

func (s *Service) PreparePunch(pin, stunServer string, refresh bool) (Snapshot, error) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return Snapshot{}, errors.New("传输服务已关闭，请重新打开扩展")
	}
	e := s.punch
	needNew := e == nil || refresh || (strings.TrimSpace(stunServer) != "" && e.stunServer != strings.TrimSpace(stunServer))
	s.mu.Unlock()

	if needNew {
		next, err := newPunchEngine(s, pin, stunServer)
		if err != nil {
			return s.Snapshot(), err
		}
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			_ = next.Close()
			return Snapshot{}, errors.New("传输服务已关闭，请重新打开扩展")
		}
		old := s.punch
		s.punch = next
		e = next
		s.mu.Unlock()
		if old != nil {
			_ = old.Close()
		}
		e.mu.Lock()
		e.preparing = !s.allowLocal
		e.mu.Unlock()
		e.rebuildToken()
		if !s.allowLocal {
			go e.gatherSTUN()
		}
		return s.Snapshot(), nil
	}

	e.setPIN(pin)
	return s.Snapshot(), nil
}

func (s *Service) PunchConnect(peerTokenRaw, pin string) error {
	s.mu.Lock()
	e := s.punch
	allowLocal := s.allowLocal
	s.mu.Unlock()
	if e == nil {
		if _, err := s.PreparePunch("", "", false); err != nil {
			return err
		}
		s.mu.Lock()
		e = s.punch
		s.mu.Unlock()
	}

	peerTok, err := DecodePunchToken(peerTokenRaw, pin)
	if err != nil {
		return err
	}
	e.mu.Lock()
	selfTok := e.selfToken
	e.mu.Unlock()

	if peerTok.SessionToken == selfTok.SessionToken {
		return errors.New("不能连接本机生成的口令")
	}
	if !allowLocal && incompatibleSymmetricNAT(selfTok, peerTok) {
		return errors.New("检测到双方均为对称型 NAT 且无共同可用的 IPv6/局域网路径，无法打洞直连")
	}

	peerLabel := peerDisplayTarget(peerTok)
	p, err := s.makeSession(false, peerLabel)
	if err != nil {
		return err
	}
	p.mode = "punch"
	p.state = "punching"
	p.expires = time.Now().Add(punchWindow)

	punchCtx, punchCancel := context.WithTimeout(p.ctx, punchWindow)
	ap := &activePunch{
		pairKey:     DerivePairKey(selfTok.SessionToken, peerTok.SessionToken),
		selfSeed:    selfTok.RoleSeed,
		peerToken:   peerTok,
		dialer:      IsDialer(selfTok.RoleSeed, selfTok.SessionToken, peerTok.RoleSeed, peerTok.SessionToken),
		ctx:         punchCtx,
		cancel:      punchCancel,
		confirmedCh: make(chan confirmedEndpoint, 16),
		dynamic:     map[netip.AddrPort]struct{}{},
		pongs:       map[netip.AddrPort]struct{}{},
	}

	e.mu.Lock()
	if e.active != nil {
		e.active.cancel()
	}
	e.active = ap
	e.mu.Unlock()

	go e.runPunchSession(p, ap)
	return nil
}

func incompatibleSymmetricNAT(self, peer PunchToken) bool {
	if self.NATType != natSymmetric || peer.NATType != natSymmetric {
		return false
	}
	hasV6 := hasCandidateKind(self.Candidates, candIPv6) && hasCandidateKind(peer.Candidates, candIPv6)
	if hasV6 {
		return false
	}
	hasLAN := hasCandidateKind(self.Candidates, candLANv4) && hasCandidateKind(peer.Candidates, candLANv4)
	return !hasLAN
}

func hasCandidateKind(cands []PunchCandidate, kind uint8) bool {
	for _, c := range cands {
		if c.Kind == kind {
			return true
		}
	}
	return false
}

func peerDisplayTarget(t PunchToken) string {
	for _, k := range []uint8{candIPv6, candSTUNv4, candLANv4} {
		for _, c := range t.Candidates {
			if c.Kind == k {
				return c.Addr.String()
			}
		}
	}
	return "P2P 节点"
}

func (e *punchEngine) handlePunchPacket(pkt []byte, raddr *net.UDPAddr) {
	e.mu.Lock()
	ap := e.active
	e.mu.Unlock()
	if ap == nil || ap.ctx.Err() != nil {
		return
	}
	if !verifyPunchPacket(ap.pairKey, pkt) {
		return
	}
	senderSeed := binary.BigEndian.Uint64(pkt[10:18])
	if senderSeed == ap.selfSeed {
		return
	}
	udpAP := normalizeUDPAddr(raddr)
	if !udpAP.IsValid() {
		return
	}
	msgType := pkt[1]
	if msgType == punchMsgPing {
		pong := buildPunchPacket(ap.pairKey, punchMsgPong, ap.selfSeed)
		_, _ = e.tr.WriteTo(pong, addrPortToUDPAddr(udpAP))
		ap.mu.Lock()
		ap.dynamic[udpAP] = struct{}{}
		ap.mu.Unlock()
		return
	}
	if msgType == punchMsgPong {
		ap.mu.Lock()
		_, already := ap.pongs[udpAP]
		ap.pongs[udpAP] = struct{}{}
		ap.mu.Unlock()
		if !already {
			select {
			case ap.confirmedCh <- confirmedEndpoint{addr: udpAP, kind: classifyEndpoint(ap, udpAP)}:
			default:
			}
		}
	}
}

func (e *punchEngine) runPunchSession(p *session, ap *activePunch) {
	defer func() {
		ap.cancel()
		e.mu.Lock()
		if e.active == ap {
			e.active = nil
		}
		e.mu.Unlock()
	}()

	// Probe loop keeps punching outward on both dialer and listener so both
	// stateful firewalls/NATs open simultaneously.
	go e.sendProbeLoop(ap)

	if ap.dialer {
		conn, err := e.runPunchDialer(p, ap)
		ap.cancel()
		if err != nil {
			if p.wasUserCancelled() {
				p.finish(nil)
			} else {
				p.finish(formatPunchError(err))
			}
			return
		}
		e.finishDialerHandshake(p, ap, conn)
		return
	}
	tc, hello, err := e.runPunchListener(p, ap)
	ap.cancel()
	if err != nil {
		if p.wasUserCancelled() {
			p.finish(nil)
		} else {
			p.finish(formatPunchError(err))
		}
		return
	}
	e.finishListenerHandshake(p, tc, hello)
}

func (p *session) wasUserCancelled() bool {
	p.service.mu.Lock()
	defer p.service.mu.Unlock()
	return p.userCancelled
}

func formatPunchError(err error) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return errors.New("打洞连接超时，请确认双方在 60 秒内同时点击连接；若双方均为对称型 NAT 可能无法直连")
	}
	return err
}

func (e *punchEngine) sendProbeLoop(ap *activePunch) {
	sendRound := func() {
		pkt := buildPunchPacket(ap.pairKey, punchMsgPing, ap.selfSeed)
		targets := make([]netip.AddrPort, 0, len(ap.peerToken.Candidates)+4)
		seen := map[netip.AddrPort]struct{}{}
		for _, c := range ap.peerToken.Candidates {
			if _, ok := seen[c.Addr]; !ok {
				seen[c.Addr] = struct{}{}
				targets = append(targets, c.Addr)
			}
		}
		ap.mu.Lock()
		for addr := range ap.dynamic {
			if _, ok := seen[addr]; !ok {
				seen[addr] = struct{}{}
				targets = append(targets, addr)
			}
		}
		ap.mu.Unlock()

		for _, target := range targets {
			if ap.ctx.Err() != nil {
				return
			}
			_, _ = e.tr.WriteTo(pkt, addrPortToUDPAddr(target))
		}
	}

	sendRound()
	t := time.NewTicker(250 * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-ap.ctx.Done():
			return
		case <-t.C:
			sendRound()
		}
	}
}

func (e *punchEngine) runPunchDialer(p *session, ap *activePunch) (*quic.Conn, error) {
	for {
		best, err := waitBestConfirmedPath(ap.ctx, ap.confirmedCh)
		if err != nil {
			if p.ctx.Err() != nil {
				return nil, p.ctx.Err()
			}
			return nil, context.DeadlineExceeded
		}
		dialCtx, cancel := context.WithTimeout(ap.ctx, 8*time.Second)
		tlsCfg := &tls.Config{
			MinVersion:         tls.VersionTLS13,
			InsecureSkipVerify: true,
			NextProtos:         []string{punchALPN},
		}
		conn, err := e.tr.Dial(dialCtx, addrPortToUDPAddr(best.addr), tlsCfg, quicConfig())
		cancel()
		if err == nil {
			e.service.mu.Lock()
			p.address = best.addr.String()
			e.service.mu.Unlock()
			return conn, nil
		}
		if ap.ctx.Err() != nil {
			return nil, ap.ctx.Err()
		}
	}
}

func waitBestConfirmedPath(ctx context.Context, ch <-chan confirmedEndpoint) (confirmedEndpoint, error) {
	var best confirmedEndpoint
	select {
	case <-ctx.Done():
		return confirmedEndpoint{}, ctx.Err()
	case first := <-ch:
		best = first
	}
	if best.kind == candLANv4 {
		return best, nil
	}
	grace := time.NewTimer(150 * time.Millisecond)
	defer grace.Stop()
	for {
		select {
		case <-ctx.Done():
			return best, nil
		case <-grace.C:
			return best, nil
		case next := <-ch:
			if candidatePriority(next.kind) < candidatePriority(best.kind) {
				best = next
				if best.kind == candLANv4 {
					return best, nil
				}
			}
		}
	}
}

func candidatePriority(kind uint8) int {
	switch kind {
	case candLANv4:
		return 0
	case candIPv6:
		return 1
	case candSTUNv4:
		return 2
	default:
		return 3
	}
}

func (e *punchEngine) runPunchListener(p *session, ap *activePunch) (*quicTransport, message, error) {
	for {
		qConn, err := e.ln.Accept(ap.ctx)
		if err != nil {
			if p.ctx.Err() != nil {
				return nil, message{}, p.ctx.Err()
			}
			return nil, message{}, context.DeadlineExceeded
		}
		authCtx, cancel := context.WithTimeout(ap.ctx, 5*time.Second)
		stream, err := qConn.AcceptStream(authCtx)
		if err != nil {
			cancel()
			_ = qConn.CloseWithError(1, "stream accept failed")
			continue
		}
		tc := newQUICTransport(qConn, stream)
		_, raw, err := tc.ReadMessage(authCtx)
		cancel()
		var hello message
		if err != nil || unmarshalHello(raw, &hello) != nil || !verifyHelloAuth(ap.pairKey, tc.TLSState(), hello.Auth) {
			_ = tc.CloseNow()
			continue
		}
		return tc, hello, nil
	}
}

func (e *punchEngine) finishDialerHandshake(p *session, ap *activePunch, qConn *quic.Conn) {
	ctx, cancel := context.WithTimeout(p.ctx, 10*time.Second)
	stream, err := qConn.OpenStreamSync(ctx)
	cancel()
	if err != nil {
		_ = qConn.CloseWithError(1, "stream open failed")
		p.finish(err)
		return
	}
	tc := newQUICTransport(qConn, stream)
	p.attach(tc)
	sas, err := channelNumber(tc.TLSState())
	if err != nil {
		p.finish(err)
		return
	}
	auth, err := computeHelloAuth(ap.pairKey, tc.TLSState())
	if err != nil {
		p.finish(err)
		return
	}
	e.service.mu.Lock()
	p.sas = sas
	p.state = "connecting"
	e.service.mu.Unlock()
	p.deadline()
	if err = p.write(message{Type: "hello", Identity: e.service.self, Auth: auth}); err != nil {
		p.finish(err)
		return
	}
	p.readLoop()
}

func (e *punchEngine) finishListenerHandshake(p *session, tc *quicTransport, hello message) {
	p.attach(tc)
	sas, err := channelNumber(tc.TLSState())
	if err != nil {
		p.finish(err)
		return
	}
	p.sas = sas
	s := e.service
	s.mu.Lock()
	p.remote = hello.Identity
	p.address = tc.conn.RemoteAddr().String()
	p.incoming = true
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

func buildPunchPacket(pairKey [32]byte, msgType byte, senderSeed uint64) []byte {
	var pkt [punchPacketSize]byte
	pkt[0] = punchMagicByte
	pkt[1] = msgType
	_, _ = rand.Read(pkt[2:10])
	binary.BigEndian.PutUint64(pkt[10:18], senderSeed)
	mac := hmac.New(sha256.New, pairKey[:])
	_, _ = mac.Write(pkt[:18])
	copy(pkt[18:], mac.Sum(nil))
	return pkt[:]
}

func verifyPunchPacket(pairKey [32]byte, pkt []byte) bool {
	if len(pkt) != punchPacketSize || pkt[0] != punchMagicByte || (pkt[1] != punchMsgPing && pkt[1] != punchMsgPong) {
		return false
	}
	mac := hmac.New(sha256.New, pairKey[:])
	_, _ = mac.Write(pkt[:18])
	return hmac.Equal(pkt[18:], mac.Sum(nil))
}

func computeHelloAuth(pairKey [32]byte, state *tls.ConnectionState) (string, error) {
	b, err := state.ExportKeyingMaterial("pocket-peer-quic-auth-v1", nil, 16)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, pairKey[:])
	_, _ = mac.Write(b)
	return fmt.Sprintf("%x", mac.Sum(nil)), nil
}

func verifyHelloAuth(pairKey [32]byte, state *tls.ConnectionState, got string) bool {
	want, err := computeHelloAuth(pairKey, state)
	if err != nil || got == "" {
		return false
	}
	return hmac.Equal([]byte(want), []byte(got))
}

func classifyEndpoint(ap *activePunch, addr netip.AddrPort) uint8 {
	for _, c := range ap.peerToken.Candidates {
		if c.Addr == addr {
			return c.Kind
		}
	}
	if addr.Addr().Is4() {
		if privateLANIPv4(addr.Addr()) {
			return candLANv4
		}
		return candSTUNv4
	}
	return candIPv6
}

func normalizeUDPAddr(ua *net.UDPAddr) netip.AddrPort {
	if ua == nil || ua.Port <= 0 || ua.Port > 65535 {
		return netip.AddrPort{}
	}
	ip, ok := netip.AddrFromSlice(ua.IP)
	if !ok {
		return netip.AddrPort{}
	}
	return netip.AddrPortFrom(ip.Unmap(), uint16(ua.Port))
}

func addrPortToUDPAddr(ap netip.AddrPort) *net.UDPAddr {
	ip := ap.Addr().Unmap()
	return &net.UDPAddr{IP: ip.AsSlice(), Port: int(ap.Port())}
}
