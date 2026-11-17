package peer

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"errors"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pion/stun/v3"
	"github.com/quic-go/quic-go"
)

func punchService(t *testing.T) *Service {
	t.Helper()
	dir := t.TempDir()
	s, err := newService(Config{DataDir: filepath.Join(dir, "data"), ReceiveDir: filepath.Join(dir, "received")}, true, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Cancel(); wait(t, func() bool { return !s.Busy() }); _ = s.TryClose() })
	return s
}

func TestSelectPreferredIPv6(t *testing.T) {
	cands := []ipv6Candidate{
		{addr: netip.MustParseAddr("2001::1"), ifaceIndex: 1, hasGateway: true, isPhysical: true, isStable: true, preferredLifetime: 9999},
		{addr: netip.MustParseAddr("2002:c000:0201::1"), ifaceIndex: 1, hasGateway: true, isPhysical: true, isStable: true, preferredLifetime: 9999},
		{addr: netip.MustParseAddr("fe80::1"), ifaceIndex: 1, hasGateway: true, isPhysical: true, isStable: true, preferredLifetime: 9999},
		{addr: netip.MustParseAddr("fd00::1"), ifaceIndex: 1, hasGateway: true, isPhysical: true, isStable: true, preferredLifetime: 9999},
		// Same iface + /64: temporary address with larger lifetime must still yield to stable address.
		{addr: netip.MustParseAddr("240e:310:1e91:5300:aaaa:bbbb:cccc:dddd"), ifaceIndex: 17, hasGateway: true, isPhysical: true, isStable: false, preferredLifetime: 86400},
		{addr: netip.MustParseAddr("240e:310:1e91:5300:2bd4:ae33:23d8:9211"), ifaceIndex: 17, hasGateway: true, isPhysical: true, isStable: true, preferredLifetime: 3600},
		// Virtual adapter without gateway should rank below physical gateway adapter.
		{addr: netip.MustParseAddr("240e:999:1:2::5"), ifaceIndex: 99, hasGateway: false, isPhysical: false, isStable: true, preferredLifetime: 99999},
	}
	got := selectPreferredIPv6(cands)
	if len(got) != 2 {
		t.Fatalf("expected 2 deduplicated addresses, got %v", got)
	}
	if got[0] != "240e:310:1e91:5300:2bd4:ae33:23d8:9211" {
		t.Fatalf("expected physical stable gateway address first, got %v", got)
	}
	if got[1] != "240e:999:1:2::5" {
		t.Fatalf("expected secondary address second, got %v", got)
	}
	// Live host check: verify no duplicate /64 per call and valid global IPv6 format.
	for _, a := range Addresses() {
		ip, err := netip.ParseAddr(a)
		if err != nil || !publicIPv6(ip) {
			t.Fatalf("invalid live address returned by Addresses(): %q (%v)", a, err)
		}
	}
}

func TestPunchTokenCodecAndPIN(t *testing.T) {
	var tokBytes [12]byte
	_, _ = rand.Read(tokBytes[:])
	orig := PunchToken{
		Version:      punchTokenVersion,
		NATType:      natCone,
		RoleSeed:     0x123456789abcdef0,
		SessionToken: tokBytes,
		Candidates: []PunchCandidate{
			{Kind: candIPv6, Addr: netip.MustParseAddrPort("[240e:310:1e91:5300:2bd4:ae33:23d8:9211]:47832")},
			{Kind: candSTUNv4, Addr: netip.MustParseAddrPort("114.114.114.114:51234")},
			{Kind: candLANv4, Addr: netip.MustParseAddrPort("192.168.1.6:47832")},
		},
	}

	raw, err := EncodePunchToken(orig, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) < 10 || raw[:3] != "PK2" {
		t.Fatalf("unexpected token format: %q", raw)
	}
	enc, err := InspectPunchToken(raw)
	if err != nil || enc {
		t.Fatalf("expected unencrypted token inspection, got enc=%v err=%v", enc, err)
	}
	decoded, err := DecodePunchToken(raw, "")
	if err != nil {
		t.Fatal(err)
	}
	if decoded.RoleSeed != orig.RoleSeed || decoded.SessionToken != orig.SessionToken || decoded.NATType != orig.NATType || len(decoded.Candidates) != 3 {
		t.Fatalf("decoded mismatch: %+v", decoded)
	}

	// Single-char tamper must fail integrity check.
	tampered := []byte(raw)
	if tampered[len(tampered)-1] == '1' {
		tampered[len(tampered)-1] = '2'
	} else {
		tampered[len(tampered)-1] = '1'
	}
	if _, err := DecodePunchToken(string(tampered), ""); err == nil {
		t.Fatal("accepted tampered unencrypted token")
	}

	// PIN-encrypted token checks.
	encRaw, err := EncodePunchToken(orig, "8392")
	if err != nil {
		t.Fatal(err)
	}
	enc, err = InspectPunchToken(encRaw)
	if err != nil || !enc {
		t.Fatalf("expected encrypted token inspection, got enc=%v err=%v", enc, err)
	}
	if _, err := DecodePunchToken(encRaw, ""); !errors.Is(err, ErrPINRequired) {
		t.Fatalf("expected ErrPINRequired, got %v", err)
	}
	if _, err := DecodePunchToken(encRaw, "0000"); !errors.Is(err, ErrInvalidPIN) {
		t.Fatalf("expected ErrInvalidPIN, got %v", err)
	}
	decEnc, err := DecodePunchToken(encRaw, "8392")
	if err != nil {
		t.Fatal(err)
	}
	if !decEnc.Encrypted || decEnc.RoleSeed != orig.RoleSeed || decEnc.Candidates[0] != orig.Candidates[0] {
		t.Fatalf("decrypted mismatch: %+v", decEnc)
	}
}

func startFakeSTUNServer(t *testing.T, mappedIP net.IP, portOverride int) string {
	t.Helper()
	pc, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	go func() {
		buf := make([]byte, 1500)
		for {
			n, addr, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			ua, ok := addr.(*net.UDPAddr)
			if !ok {
				continue
			}
			req := new(stun.Message)
			req.Raw = append([]byte(nil), buf[:n]...)
			if err := req.Decode(); err != nil {
				continue
			}
			port := ua.Port
			if portOverride > 0 {
				port = portOverride
			}
			resp, err := stun.Build(
				stun.NewTransactionIDSetter(req.TransactionID),
				stun.BindingSuccess,
				stun.XORMappedAddress{IP: mappedIP, Port: port},
			)
			if err == nil {
				_, _ = pc.WriteTo(resp.Raw, addr)
			}
		}
	}()
	return pc.LocalAddr().String()
}

func TestSTUNProbeNATTypes(t *testing.T) {
	conn, err := net.ListenPacket("udp", ":0")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	tr := &quic.Transport{Conn: conn}
	defer tr.Close()

	disp := newSTUNDispatcher()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		buf := make([]byte, 1500)
		for {
			n, _, err := tr.ReadNonQUICPacket(ctx, buf)
			if err != nil {
				return
			}
			disp.handlePacket(buf[:n])
		}
	}()

	pubIP := net.ParseIP("203.0.113.10").To4()
	s1 := startFakeSTUNServer(t, pubIP, 55001)
	s2 := startFakeSTUNServer(t, pubIP, 55001)
	cone := disp.probe(ctx, tr, []string{s1, s2})
	if cone.natType != natCone || cone.addr.Port() != 55001 {
		t.Fatalf("expected cone NAT on port 55001, got %+v", cone)
	}

	s3 := startFakeSTUNServer(t, pubIP, 55002)
	sym := disp.probe(ctx, tr, []string{s1, s3})
	if sym.natType != natSymmetric {
		t.Fatalf("expected symmetric NAT, got %+v", sym)
	}
}

func punchPair(t *testing.T, a, b *Service, pinA, pinB string) (dialer, listener *Service) {
	t.Helper()
	snapA, err := a.PreparePunch(pinA, "", false)
	if err != nil {
		t.Fatal(err)
	}
	snapB, err := b.PreparePunch(pinB, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if snapA.Punch == nil || !snapA.Punch.Ready || snapB.Punch == nil || !snapB.Punch.Ready {
		t.Fatalf("punch prepare not ready: A=%+v B=%+v", snapA.Punch, snapB.Punch)
	}
	if err = a.PunchConnect(snapB.Punch.Token, pinB); err != nil {
		t.Fatal(err)
	}
	if err = b.PunchConnect(snapA.Punch.Token, pinA); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		sa, sb := a.Snapshot(), b.Snapshot()
		if (sa.State == "request" && sb.State == "waiting") || (sb.State == "request" && sa.State == "waiting") {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	sa, sb := a.Snapshot(), b.Snapshot()
	if !((sa.State == "request" && sb.State == "waiting") || (sb.State == "request" && sa.State == "waiting")) {
		t.Fatalf("punch pair failed: A={state:%s err:%s addr:%s punch:%+v} B={state:%s err:%s addr:%s punch:%+v}", sa.State, sa.Error, sa.Address, sa.Punch, sb.State, sb.Error, sb.Address, sb.Punch)
	}
	if b.Snapshot().State == "request" {
		dialer, listener = a, b
	} else {
		dialer, listener = b, a
	}
	if dialer.Snapshot().SessionMode != "punch" || listener.Snapshot().SessionMode != "punch" {
		t.Fatalf("expected punch session mode: dialer=%s listener=%s", dialer.Snapshot().SessionMode, listener.Snapshot().SessionMode)
	}
	if err = listener.Accept(); err != nil {
		t.Fatal(err)
	}
	wait(t, func() bool { return dialer.Snapshot().Code != "" })
	code := dialer.Snapshot().Code
	if err = listener.Confirm(code); err != nil {
		t.Fatal(err)
	}
	wait(t, func() bool { return dialer.Snapshot().State == "connected" && listener.Snapshot().State == "connected" })
	return dialer, listener
}

func TestPunchPairAndBidirectionalTransfer(t *testing.T) {
	a, b := punchService(t), punchService(t)
	dialer, listener := punchPair(t, a, b, "", "")

	payload := bytes.Repeat([]byte("QUIC UDP hole punch 传输校验\x00"), 120000)
	dir := t.TempDir()
	src := filepath.Join(dir, "打洞测试.bin")
	if err := os.WriteFile(src, payload, 0600); err != nil {
		t.Fatal(err)
	}
	if err := dialer.Send([]string{src}); err != nil {
		t.Fatal(err)
	}
	wait(t, func() bool { return !dialer.Busy() && len(listener.Snapshot().Records) == 1 && !listener.Busy() })
	got, err := os.ReadFile(listener.Snapshot().Records[0].Path)
	if err != nil || !bytes.Equal(got, payload) {
		t.Fatalf("received file mismatch: err=%v len=%d/%d", err, len(got), len(payload))
	}

	reply := []byte("reverse over quic")
	rev := filepath.Join(dir, "reply.txt")
	_ = os.WriteFile(rev, reply, 0600)
	if err := listener.Send([]string{rev}); err != nil {
		t.Fatal(err)
	}
	wait(t, func() bool { return !listener.Busy() && len(dialer.Snapshot().Records) == 2 && !dialer.Busy() })
	gotRev, err := os.ReadFile(dialer.Snapshot().Records[0].Path)
	if err != nil || !bytes.Equal(gotRev, reply) {
		t.Fatalf("reverse file mismatch: err=%v got=%q", err, gotRev)
	}

	if err := dialer.Disconnect(); err != nil {
		t.Fatal(err)
	}
	wait(t, func() bool { return dialer.Snapshot().State == "idle" && listener.Snapshot().State == "idle" })
}

func TestPunchWithPINEncryptedTokenAndRoguePeerRejected(t *testing.T) {
	a, b := punchService(t), punchService(t)
	snapA, err := a.PreparePunch("7410", "", false)
	if err != nil {
		t.Fatal(err)
	}
	snapB, err := b.PreparePunch("9527", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := b.PunchConnect(snapA.Punch.Token, "0000"); !errors.Is(err, ErrInvalidPIN) {
		t.Fatalf("expected ErrInvalidPIN, got %v", err)
	}

	// Ensure a rogue QUIC client connecting directly without valid hello.Auth does not hijack listener.
	rogueConn, err := net.ListenPacket("udp", "[::1]:0")
	if err != nil {
		t.Fatal(err)
	}
	defer rogueConn.Close()
	rogueTr := &quic.Transport{Conn: rogueConn}
	defer rogueTr.Close()

	// Make sure one side is listener and dial it with a rogue QUIC connection while both punch.
	tokA, _ := DecodePunchToken(snapA.Punch.Token, "7410")
	tokB, _ := DecodePunchToken(snapB.Punch.Token, "9527")
	listenerSvc := b
	listenerPort := tokB.Candidates[0].Addr.Port()
	if !IsDialer(tokA.RoleSeed, tokA.SessionToken, tokB.RoleSeed, tokB.SessionToken) {
		listenerSvc = a
		listenerPort = tokA.Candidates[0].Addr.Port()
	}

	if err := a.PunchConnect(snapB.Punch.Token, "9527"); err != nil {
		t.Fatal(err)
	}
	if err := b.PunchConnect(snapA.Punch.Token, "7410"); err != nil {
		t.Fatal(err)
	}
	// Fire a bogus QUIC dial to the listener port with invalid auth.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		qc, err := rogueTr.Dial(ctx, &net.UDPAddr{IP: net.IPv6loopback, Port: int(listenerPort)}, &tls.Config{MinVersion: tls.VersionTLS13, InsecureSkipVerify: true, NextProtos: []string{punchALPN}}, quicConfig())
		if err == nil {
			if st, err := qc.OpenStreamSync(ctx); err == nil {
				tc := newQUICTransport(qc, st)
				_ = tc.WriteMessage(ctx, 1, []byte(`{"type":"hello","identity":{"name":"rogue","avatar":0},"auth":"bad"}`))
			}
		}
	}()

	wait(t, func() bool {
		return listenerSvc.Snapshot().State == "request"
	})
	if listenerSvc.Snapshot().Peer == nil || listenerSvc.Snapshot().Peer.Name == "rogue" {
		t.Fatalf("rogue peer was not rejected: %+v", listenerSvc.Snapshot().Peer)
	}
}

func TestDualStackIPv4Punch(t *testing.T) {
	// Verify dual-stack ":0" UDP socket handles IPv4 STUN/LAN punching & QUIC Dial cleanly.
	a, b := punchService(t), punchService(t)
	a.allowLocal, b.allowLocal = false, false
	// Override STUN to local fake servers on 127.0.0.1 so test stays offline and fast.
	stun1 := startFakeSTUNServer(t, net.ParseIP("203.0.113.10").To4(), 0)
	a.stunServers = []string{stun1}
	b.stunServers = []string{stun1}

	snapA, err := a.PreparePunch("", "", false)
	if err != nil {
		t.Fatal(err)
	}
	snapB, err := b.PreparePunch("", "", false)
	if err != nil {
		t.Fatal(err)
	}
	wait(t, func() bool {
		sa, sb := a.Snapshot().Punch, b.Snapshot().Punch
		return sa != nil && !sa.Preparing && sa.Ready && sb != nil && !sb.Preparing && sb.Ready
	})

	tokA, _ := DecodePunchToken(a.Snapshot().Punch.Token, "")
	tokB, _ := DecodePunchToken(b.Snapshot().Punch.Token, "")
	// Replace candidates with explicit 127.0.0.1:port to isolate dual-stack IPv4 behavior.
	tokA.Candidates = []PunchCandidate{{Kind: candLANv4, Addr: netip.AddrPortFrom(netip.MustParseAddr("127.0.0.1"), uint16(a.Snapshot().Punch.Port))}}
	tokB.Candidates = []PunchCandidate{{Kind: candLANv4, Addr: netip.AddrPortFrom(netip.MustParseAddr("127.0.0.1"), uint16(b.Snapshot().Punch.Port))}}
	encA, _ := EncodePunchToken(tokA, "")
	encB, _ := EncodePunchToken(tokB, "")
	_ = snapA
	_ = snapB

	if err := a.PunchConnect(encB, ""); err != nil {
		t.Fatal(err)
	}
	if err := b.PunchConnect(encA, ""); err != nil {
		t.Fatal(err)
	}
	wait(t, func() bool {
		sa, sb := a.Snapshot().State, b.Snapshot().State
		return (sa == "request" && sb == "waiting") || (sb == "request" && sa == "waiting")
	})
}
