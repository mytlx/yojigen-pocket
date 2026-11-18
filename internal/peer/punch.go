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
	punchMagicByte  byte = 0x28 // top two bits are 00 so quic.Transport routes to ReadNonQUICPacket
	punchMsgPing    byte = 1
	punchMsgPong    byte = 2
	punchPacketSize      = 50
	punchWindow          = 60 * time.Second
	punchALPN            = "pocket-peer-quic-v2"
)

type PunchSnapshot struct {
	Ready       bool     `json:"ready"`
	Preparing   bool     `json:"preparing"`
	Token       string   `json:"token,omitempty"`
	Encrypted   bool     `json:"encrypted"`
	NATType     string   `json:"natType,omitempty"`
	HasIPv6     bool     `json:"hasIPv6"`
	Port        int      `json:"port,omitempty"`
	V6Port      int      `json:"v6Port,omitempty"`
	V4Port      int      `json:"v4Port,omitempty"`
	Candidates  []string `json:"candidates,omitempty"`
	STUNError   string   `json:"stunError,omitempty"`
	Error       string   `json:"error,omitempty"`
	SentProbes  int      `json:"sentProbes,omitempty"`
	RecvPings   int      `json:"recvPings,omitempty"`
	RecvPongs   int      `json:"recvPongs,omitempty"`
	PeerNAT     string   `json:"peerNat,omitempty"`
	PeerTargets []string `json:"peerTargets,omitempty"`
	LastRemote  string   `json:"lastRemote,omitempty"`
	DialError   string   `json:"dialError,omitempty"`
}

type punchSocket struct {
	isV6    bool
	boundIP netip.Addr
	conn    net.PacketConn
	tr      *quic.Transport
	ln      *quic.Listener
	port    uint16
}

type punchEngine struct {
	service *Service
	v6Sock  *punchSocket
	v4Sock  *punchSocket
	stun    *stunDispatcher
	ctx     context.Context
	cancel  context.CancelFunc

	mu         sync.Mutex
	pin        string
	stunServer string
	preparing  bool
	natType    uint8
	stunAddr   netip.AddrPort
	mappedV6   netip.AddrPort
	stunNote   string
	lastErr    string
	selfToken  PunchToken
	tokenStr   string
	candLabels []string
	active     *activePunch
}

type confirmedEndpoint struct {
	sock *punchSocket
	addr netip.AddrPort
	kind uint8
}

type activePunch struct {
	pairKey     [32]byte
	selfSeed    uint64
	peerToken   PunchToken
	peerTargets []string
	dialer      bool
	ctx         context.Context
	cancel      context.CancelFunc
	confirmedCh chan confirmedEndpoint

	mu         sync.Mutex
	dynamic    map[netip.AddrPort]struct{}
	confirmed  map[netip.AddrPort]confirmedEndpoint
	sentProbes int
	recvPings  int
	recvPongs  int
	lastRemote string
	dialError  string
}

func openPunchSocket(network, bindAddr string, isV6 bool, boundIP netip.Addr, tlsCfg *tls.Config) (*punchSocket, error) {
	conn, err := net.ListenPacket(network, bindAddr)
	if err != nil {
		return nil, err
	}
	ua, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok || ua.Port == 0 {
		_ = conn.Close()
		return nil, errors.New("无法获取本地 UDP 端口")
	}
	tr := &quic.Transport{Conn: conn}
	ln, err := tr.Listen(tlsCfg, quicConfig())
	if err != nil {
		_ = tr.Close()
		_ = conn.Close()
		return nil, err
	}
	return &punchSocket{
		isV6:    isV6,
		boundIP: boundIP,
		conn:    conn,
		tr:      tr,
		ln:      ln,
		port:    uint16(ua.Port),
	}, nil
}

func (ps *punchSocket) Close() {
	if ps == nil {
		return
	}
	if ps.ln != nil {
		_ = ps.ln.Close()
	}
	if ps.tr != nil {
		_ = ps.tr.Close()
	}
	if ps.conn != nil {
		_ = ps.conn.Close()
	}
}

func newPunchEngine(s *Service, pin, stunServer string) (*punchEngine, error) {
	cert, err := certificate()
	if err != nil {
		return nil, err
	}
	tlsCfg := &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS13,
		NextProtos:   []string{punchALPN},
	}

	var v6Sock, v4Sock *punchSocket
	if s.allowLocal {
		if len(s.stunServers) > 0 {
			v4Sock, err = openPunchSocket("udp4", "127.0.0.1:0", false, netip.Addr{}, tlsCfg)
			if err != nil {
				return nil, fmt.Errorf("UDP4 打洞端口无法监听：%w", err)
			}
		} else {
			v6Sock, err = openPunchSocket("udp6", "[::1]:0", true, netip.IPv6Loopback(), tlsCfg)
			if err != nil {
				return nil, fmt.Errorf("UDP6 打洞端口无法监听：%w", err)
			}
		}
	} else {
		// Bind IPv6 explicitly to the advertised address so Windows/OS privacy
		// extensions never substitute a different source IPv6 for outbound packets.
		if chosenV6 := choosePunchIPv6(); chosenV6.IsValid() {
			if sock, err := openPunchSocket("udp6", net.JoinHostPort(chosenV6.String(), "0"), true, chosenV6, tlsCfg); err == nil {
				v6Sock = sock
			}
		}
		if sock, err := openPunchSocket("udp4", "0.0.0.0:0", false, netip.Addr{}, tlsCfg); err == nil {
			v4Sock = sock
		}
		if v6Sock == nil && v4Sock == nil {
			return nil, errors.New("无法监听本地 UDP6 或 UDP4 端口")
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	e := &punchEngine{
		service:    s,
		v6Sock:     v6Sock,
		v4Sock:     v4Sock,
		stun:       newSTUNDispatcher(),
		ctx:        ctx,
		cancel:     cancel,
		pin:        strings.TrimSpace(pin),
		stunServer: strings.TrimSpace(stunServer),
	}
	e.selfToken.Version = punchTokenVersion
	if err = fillRandomTokenIdentity(&e.selfToken); err != nil {
		_ = e.Close()
		return nil, err
	}
	if v6Sock != nil {
		go e.readNonQUICLoop(v6Sock)
	}
	if v4Sock != nil {
		go e.readNonQUICLoop(v4Sock)
	}
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
	e.v6Sock.Close()
	e.v4Sock.Close()
	return nil
}

func (e *punchEngine) readNonQUICLoop(sock *punchSocket) {
	buf := make([]byte, 2048)
	for {
		n, raddr, err := sock.tr.ReadNonQUICPacket(e.ctx, buf)
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
				e.handlePunchPacket(sock, pkt, ua)
			}
		}
	}
}

func (e *punchEngine) gatherInitial() {
	var servers []string
	e.mu.Lock()
	custom := e.stunServer
	e.mu.Unlock()
	if custom != "" {
		servers = []string{custom}
	} else {
		servers = append([]string(nil), e.service.stunServers...)
	}

	var wg sync.WaitGroup
	var v4Res stunProbeResult
	var v6Res stunProbeResult
	if e.v4Sock != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v4Res = e.stun.probe(e.ctx, e.v4Sock.tr, "udp4", servers)
		}()
	}
	if e.v6Sock != nil && !e.service.allowLocal {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v6Res = e.stun.probe(e.ctx, e.v6Sock.tr, "udp6", []string{"stun.cloudflare.com:3478"})
		}()
	}
	wg.Wait()

	e.mu.Lock()
	e.stunAddr = v4Res.addr
	e.natType = v4Res.natType
	e.stunNote = v4Res.errNote
	e.mappedV6 = v6Res.addr
	e.preparing = false
	e.mu.Unlock()
	e.rebuildToken()
}

func (e *punchEngine) setPIN(pin string) {
	e.mu.Lock()
	e.pin = strings.TrimSpace(pin)
	preparing := e.preparing
	e.mu.Unlock()
	if !preparing {
		e.rebuildToken()
	}
}

func (e *punchEngine) rebuildToken() {
	e.mu.Lock()
	stunAddr := e.stunAddr
	mappedV6 := e.mappedV6
	nat := e.natType
	pin := e.pin
	allowLocal := e.service.allowLocal
	e.mu.Unlock()

	var cands []PunchCandidate
	var labels []string
	if allowLocal {
		if e.v6Sock != nil {
			ap := netip.AddrPortFrom(e.v6Sock.boundIP, e.v6Sock.port)
			cands = append(cands, PunchCandidate{Kind: candIPv6, Addr: ap})
			labels = append(labels, fmt.Sprintf("回环测试 · %s", ap))
		}
		if e.v4Sock != nil && stunAddr.IsValid() {
			cands = append(cands, PunchCandidate{Kind: candSTUNv4, Addr: stunAddr})
			labels = append(labels, fmt.Sprintf("公网 IPv4 (STUN) · %s", stunAddr))
		}
	} else {
		if e.v6Sock != nil && e.v6Sock.boundIP.IsValid() {
			localV6 := netip.AddrPortFrom(e.v6Sock.boundIP, e.v6Sock.port)
			cands = append(cands, PunchCandidate{Kind: candIPv6, Addr: localV6})
			labels = append(labels, fmt.Sprintf("公网 IPv6 · %s", localV6))
			if mappedV6.IsValid() && mappedV6 != localV6 {
				cands = append(cands, PunchCandidate{Kind: candIPv6, Addr: mappedV6})
				labels = append(labels, fmt.Sprintf("公网 IPv6 (映射) · %s", mappedV6))
			}
		}
		if stunAddr.IsValid() {
			cands = append(cands, PunchCandidate{Kind: candSTUNv4, Addr: stunAddr})
			labels = append(labels, fmt.Sprintf("公网 IPv4 (STUN) · %s", stunAddr))
		}
		if e.v4Sock != nil {
			for i, ip := range localIPv4s() {
				if i >= 2 {
					break
				}
				ap := netip.AddrPortFrom(ip, e.v4Sock.port)
				cands = append(cands, PunchCandidate{Kind: candLANv4, Addr: ap})
				labels = append(labels, fmt.Sprintf("局域网 · %s", ap))
			}
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
	snap := &PunchSnapshot{
		Ready:      !e.preparing && e.tokenStr != "",
		Preparing:  e.preparing,
		Token:      e.tokenStr,
		Encrypted:  e.pin != "",
		NATType:    natTypeString(e.natType),
		HasIPv6:    e.v6Sock != nil && e.v6Sock.boundIP.IsValid(),
		Candidates: append([]string{}, e.candLabels...),
		STUNError:  e.stunNote,
		Error:      e.lastErr,
	}
	if e.v6Sock != nil {
		snap.V6Port = int(e.v6Sock.port)
		snap.Port = int(e.v6Sock.port)
	}
	if e.v4Sock != nil {
		snap.V4Port = int(e.v4Sock.port)
		if snap.Port == 0 {
			snap.Port = int(e.v4Sock.port)
		}
	}
	ap := e.active
	e.mu.Unlock()

	if ap != nil {
		ap.mu.Lock()
		snap.SentProbes = ap.sentProbes
		snap.RecvPings = ap.recvPings
		snap.RecvPongs = ap.recvPongs
		snap.LastRemote = ap.lastRemote
		snap.DialError = ap.dialError
		snap.PeerNAT = natTypeString(ap.peerToken.NATType)
		snap.PeerTargets = append([]string{}, ap.peerTargets...)
		ap.mu.Unlock()
	}
	return snap
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
		if s.allowLocal && len(s.stunServers) == 0 {
			e.rebuildToken()
		} else {
			e.mu.Lock()
			e.preparing = true
			e.mu.Unlock()
			go e.gatherInitial()
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

	e.mu.Lock()
	preparing := e.preparing
	selfTok := e.selfToken
	e.mu.Unlock()
	if preparing {
		return errors.New("正在完成网络路径探测，请稍等 1 秒后再开始")
	}

	peerTok, err := DecodePunchToken(peerTokenRaw, pin)
	if err != nil {
		return err
	}
	if peerTok.SessionToken == selfTok.SessionToken {
		return errors.New("不能连接本机生成的口令")
	}
	if !allowLocal && incompatibleSymmetricNAT(selfTok, peerTok) {
		return errors.New("检测到双方均为对称型 NAT 且无共同可用的 IPv6/局域网路径，无法打洞直连")
	}
	if !hasReachableOverlap(e, peerTok) {
		return errors.New("双方没有可用的共同网络协议路径（例如一方仅有 IPv6、另一方仅有 IPv4），请重新刷新口令后再试")
	}

	peerTargets := make([]string, 0, len(peerTok.Candidates))
	for _, c := range peerTok.Candidates {
		peerTargets = append(peerTargets, formatCandidateLabel(c))
	}

	peerLabel := peerDisplayTarget(peerTok)
	p, err := s.makeSession(false, peerLabel)
	if err != nil {
		return err
	}
	s.mu.Lock()
	p.mode = "punch"
	p.state = "punching"
	p.expires = time.Now().Add(punchWindow)
	s.mu.Unlock()

	punchCtx, punchCancel := context.WithTimeout(p.ctx, punchWindow)
	ap := &activePunch{
		pairKey:     DerivePairKey(selfTok.SessionToken, peerTok.SessionToken),
		selfSeed:    selfTok.RoleSeed,
		peerToken:   peerTok,
		peerTargets: peerTargets,
		dialer:      IsDialer(selfTok.RoleSeed, selfTok.SessionToken, peerTok.RoleSeed, peerTok.SessionToken),
		ctx:         punchCtx,
		cancel:      punchCancel,
		confirmedCh: make(chan confirmedEndpoint, 16),
		dynamic:     map[netip.AddrPort]struct{}{},
		confirmed:   map[netip.AddrPort]confirmedEndpoint{},
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

func formatCandidateLabel(c PunchCandidate) string {
	switch c.Kind {
	case candIPv6:
		return "IPv6 · " + c.Addr.String()
	case candLANv4:
		return "局域网 · " + c.Addr.String()
	case candSTUNv4:
		return "IPv4 · " + c.Addr.String()
	default:
		return c.Addr.String()
	}
}

func hasReachableOverlap(e *punchEngine, peerTok PunchToken) bool {
	hasPeerV6 := hasCandidateKind(peerTok.Candidates, candIPv6)
	hasPeerV4 := hasCandidateKind(peerTok.Candidates, candSTUNv4) || hasCandidateKind(peerTok.Candidates, candLANv4)
	if e.v6Sock != nil && hasPeerV6 {
		return true
	}
	if e.v4Sock != nil && hasPeerV4 {
		return true
	}
	return false
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

func (e *punchEngine) socketForAddr(ap netip.AddrPort) *punchSocket {
	if ap.Addr().Is6() {
		return e.v6Sock
	}
	return e.v4Sock
}

func (e *punchEngine) handlePunchPacket(sock *punchSocket, pkt []byte, raddr *net.UDPAddr) {
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
		_, _ = sock.tr.WriteTo(pong, addrPortToUDPAddr(udpAP))
		ap.mu.Lock()
		ap.recvPings++
		ap.lastRemote = udpAP.String()
		ap.dynamic[udpAP] = struct{}{}
		ap.mu.Unlock()
		return
	}
	if msgType == punchMsgPong {
		ep := confirmedEndpoint{sock: sock, addr: udpAP, kind: classifyEndpoint(ap, udpAP)}
		ap.mu.Lock()
		ap.recvPongs++
		ap.lastRemote = udpAP.String()
		_, already := ap.confirmed[udpAP]
		ap.confirmed[udpAP] = ep
		ap.mu.Unlock()
		if !already {
			select {
			case ap.confirmedCh <- ep:
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
				p.finish(formatPunchError(err, ap))
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
			p.finish(formatPunchError(err, ap))
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

func formatPunchError(err error, ap *activePunch) error {
	if !errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	ap.mu.Lock()
	pings := ap.recvPings
	pongs := ap.recvPongs
	dialErr := ap.dialError
	ap.mu.Unlock()
	if pings == 0 && pongs == 0 {
		return errors.New("打洞超时：未收到对方任何探测包（可能网络/运营商防火墙拦截或口令不一致）")
	}
	if dialErr != "" {
		return fmt.Errorf("已收到对方探测但加密通道握手超时：%s", dialErr)
	}
	return errors.New("打洞连接超时，请确认双方在 60 秒内同时点击连接")
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
		ap.sentProbes++
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
			sock := e.socketForAddr(target)
			if sock == nil {
				continue
			}
			_, _ = sock.tr.WriteTo(pkt, addrPortToUDPAddr(target))
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
		best, err := waitBestConfirmedPath(ap)
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
		conn, err := best.sock.tr.Dial(dialCtx, addrPortToUDPAddr(best.addr), tlsCfg, quicConfig())
		cancel()
		if err == nil {
			e.service.mu.Lock()
			p.address = best.addr.String()
			e.service.mu.Unlock()
			return conn, nil
		}
		ap.mu.Lock()
		ap.dialError = err.Error()
		ap.mu.Unlock()
		if ap.ctx.Err() != nil {
			return nil, ap.ctx.Err()
		}
		select {
		case <-ap.ctx.Done():
			return nil, ap.ctx.Err()
		case <-time.After(400 * time.Millisecond):
		}
	}
}

func bestKnownConfirmed(ap *activePunch) (confirmedEndpoint, bool) {
	ap.mu.Lock()
	defer ap.mu.Unlock()
	var best confirmedEndpoint
	var ok bool
	for _, ep := range ap.confirmed {
		if !ok || candidatePriority(ep.kind) < candidatePriority(best.kind) {
			best = ep
			ok = true
		}
	}
	return best, ok
}

func waitBestConfirmedPath(ap *activePunch) (confirmedEndpoint, error) {
	var best confirmedEndpoint
	if existing, ok := bestKnownConfirmed(ap); ok {
		best = existing
	} else {
		select {
		case <-ap.ctx.Done():
			return confirmedEndpoint{}, ap.ctx.Err()
		case first := <-ap.confirmedCh:
			best = first
		}
	}
	if best.kind == candLANv4 {
		return best, nil
	}
	grace := time.NewTimer(150 * time.Millisecond)
	defer grace.Stop()
	for {
		select {
		case <-ap.ctx.Done():
			return best, nil
		case <-grace.C:
			return best, nil
		case next := <-ap.confirmedCh:
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
	type accepted struct {
		tc    *quicTransport
		hello message
	}
	winCh := make(chan accepted, 1)
	acceptCtx, acceptCancel := context.WithCancel(ap.ctx)
	defer acceptCancel()

	var wg sync.WaitGroup
	listenOn := func(sock *punchSocket) {
		defer wg.Done()
		for {
			qConn, err := sock.ln.Accept(acceptCtx)
			if err != nil {
				return
			}
			authCtx, cancel := context.WithTimeout(acceptCtx, 5*time.Second)
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
			select {
			case winCh <- accepted{tc: tc, hello: hello}:
				acceptCancel()
				return
			default:
				_ = tc.CloseNow()
				return
			}
		}
	}

	if e.v6Sock != nil {
		wg.Add(1)
		go listenOn(e.v6Sock)
	}
	if e.v4Sock != nil {
		wg.Add(1)
		go listenOn(e.v4Sock)
	}

	select {
	case win := <-winCh:
		wg.Wait()
		return win.tc, win.hello, nil
	case <-ap.ctx.Done():
		acceptCancel()
		wg.Wait()
		if p.ctx.Err() != nil {
			return nil, message{}, p.ctx.Err()
		}
		return nil, message{}, context.DeadlineExceeded
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
	auth, err := computeHelloAuth(ap.pairKey, tc.TLSState())
	if err != nil {
		p.finish(err)
		return
	}
	e.service.mu.Lock()
	p.state = "connecting"
	e.service.mu.Unlock()
	p.deadline()
	if err = p.write(message{Type: "hello", Identity: e.service.self, Auth: auth}); err != nil {
		p.finish(err)
		return
	}
	p.sas, err = p.pairingNumber(false)
	if err != nil {
		p.finish(err)
		return
	}
	p.readLoop()
}

func (e *punchEngine) finishListenerHandshake(p *session, tc *quicTransport, hello message) {
	p.attach(tc)
	sas, err := p.pairingNumber(true)
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
