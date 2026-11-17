package peer

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func service(t *testing.T) *Service {
	t.Helper()
	dir := t.TempDir()
	s, err := newService(Config{DataDir: filepath.Join(dir, "data"), ReceiveDir: filepath.Join(dir, "received")}, true, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Cancel(); wait(t, func() bool { return !s.Busy() }); _ = s.TryClose() })
	return s
}
func wait(t *testing.T, fn func() bool) {
	t.Helper()
	until := time.Now().Add(8 * time.Second)
	for time.Now().Before(until) {
		if fn() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition timed out")
}
func connect(t *testing.T, a, b *Service) {
	t.Helper()
	if err := a.connectTo("::1", b.port); err != nil {
		t.Fatal(err)
	}
	wait(t, func() bool { return b.Snapshot().State == "request" && a.Snapshot().State == "waiting" })
}
func pair(t *testing.T, a, b *Service) {
	t.Helper()
	connect(t, a, b)
	if err := b.Accept(); err != nil {
		t.Fatal(err)
	}
	wait(t, func() bool { return a.Snapshot().Code != "" })
	code := a.Snapshot().Code
	v := b.Snapshot()
	if len(v.Choices) != 3 || v.Code != "" {
		t.Fatalf("receiver exposed answer: %+v", v)
	}
	found := false
	for _, n := range v.Choices {
		found = found || n == code
	}
	if !found {
		t.Fatal("TLS exporter numbers do not match")
	}
	if err := b.Confirm(code); err != nil {
		t.Fatal(err)
	}
	wait(t, func() bool { return a.Snapshot().State == "connected" && b.Snapshot().State == "connected" })
}
func TestPairAndTransfer(t *testing.T) {
	a, b := service(t), service(t)
	pair(t, a, b)
	data := bytes.Repeat([]byte("IPv6 点对点传输\x00"), 150000)
	dir := t.TempDir()
	file := filepath.Join(dir, "样例.bin")
	if err := os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := a.Send([]string{file}); err != nil {
		t.Fatal(err)
	}
	wait(t, func() bool { return !a.Busy() && len(b.Snapshot().Records) == 1 && !b.Busy() })
	for _, s := range []*Service{a, b} {
		r := s.Snapshot().Records[0]
		if r.Status != "completed" || r.Done != int64(len(data)) {
			t.Fatalf("bad record: %+v", r)
		}
	}
	got, err := os.ReadFile(b.Snapshot().Records[0].Path)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatal("received bytes differ", err)
	}
	if err = a.Send([]string{file}); err != nil {
		t.Fatal(err)
	}
	wait(t, func() bool { return !a.Busy() && len(b.Snapshot().Records) == 2 && !b.Busy() })
	if b.Snapshot().Records[0].Path == b.Snapshot().Records[1].Path {
		t.Fatal("same-name file was overwritten")
	}
	empty := filepath.Join(dir, "empty")
	_ = os.WriteFile(empty, nil, 0600)
	if err = b.Send([]string{empty}); err != nil {
		t.Fatal(err)
	}
	wait(t, func() bool { return !b.Busy() && len(a.Snapshot().Records) == 3 && !a.Busy() })
	if a.Snapshot().Records[0].Status != "completed" {
		t.Fatal(a.Snapshot())
	}
}
func TestWrongNumberRejects(t *testing.T) {
	a, b := service(t), service(t)
	connect(t, a, b)
	if err := b.Accept(); err != nil {
		t.Fatal(err)
	}
	wait(t, func() bool { return a.Snapshot().Code != "" })
	wrong := ""
	for _, n := range b.Snapshot().Choices {
		if n != a.Snapshot().Code {
			wrong = n
		}
	}
	if err := b.Confirm(wrong); err == nil {
		t.Fatal("wrong answer accepted")
	}
	wait(t, func() bool { return a.Snapshot().State == "idle" && b.Snapshot().State == "idle" })
	if err := a.Send([]string{"/missing"}); err == nil {
		t.Fatal("send accepted")
	}
}
func TestUnverifiedPeerCannotSend(t *testing.T) {
	a, b := service(t), service(t)
	connect(t, a, b)
	a.mu.Lock()
	p := a.current
	a.mu.Unlock()
	_ = p.write(message{Type: "file", ID: randomID(), Name: "no.txt", Size: 1})
	wait(t, func() bool { return b.Snapshot().State == "idle" })
	if len(b.Snapshot().Records) != 0 {
		t.Fatal("unverified file created")
	}
}
func TestCancelAndExitGuard(t *testing.T) {
	a, b := service(t), service(t)
	pair(t, a, b)
	file := filepath.Join(t.TempDir(), "large.bin")
	f, err := os.Create(file)
	if err != nil {
		t.Fatal(err)
	}
	_ = f.Truncate(128 << 20)
	f.Close()
	if err = a.Send([]string{file, file}); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(a.TryClose(), ErrBusy) {
		t.Fatal("allowed quit with pending files")
	}
	a.Cancel()
	wait(t, func() bool { return !a.Busy() && !b.Busy() })
	for _, r := range a.Snapshot().Records {
		if r.Status == "queued" || r.Status == "transferring" {
			t.Fatal("stuck transfer", r)
		}
	}
	files, _ := filepath.Glob(filepath.Join(b.folder, ".pocket-*"))
	if len(files) != 0 {
		t.Fatal("partial files remain", files)
	}
}
func TestChecksumFailureRemovesPartial(t *testing.T) {
	a, b := service(t), service(t)
	pair(t, a, b)
	a.mu.Lock()
	p := a.current
	a.mu.Unlock()
	id := randomID()
	if err := p.write(message{Type: "file", ID: id, Name: "bad.bin", Size: 3}); err != nil {
		t.Fatal(err)
	}
	if _, err := p.waitAck(id, "file-ready"); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(b.TryClose(), ErrBusy) {
		t.Fatal("receiver allowed quit")
	}
	_ = p.writeBytes(2, append([]byte(id), []byte("abc")...))
	sum := sha256.Sum256([]byte("wrong"))
	_ = p.write(message{Type: "file-end", ID: id, Hash: hex.EncodeToString(sum[:])})
	wait(t, func() bool { return b.Snapshot().State == "idle" && !b.Busy() })
	if b.Snapshot().Records[0].Status == "completed" {
		t.Fatal("bad digest accepted")
	}
	files, _ := os.ReadDir(b.folder)
	if len(files) != 0 {
		t.Fatal("corrupt file retained")
	}
}
func TestSafeNames(t *testing.T) {
	for _, n := range []string{"../secret", "a/b", "a\\b", "C:evil", "..", "a\x00b", "a\nb"} {
		if _, err := safeName(n); err == nil {
			t.Fatalf("accepted %q", n)
		}
	}
	if got, err := safeName("CON.txt"); err != nil || got != "_CON.txt" {
		t.Fatal(got, err)
	}
}
func TestProductionRejectsNonPublicIPv6(t *testing.T) {
	for _, raw := range []string{"127.0.0.1", "::1", "fe80::1", "fd00::1", "::ffff:192.0.2.1"} {
		s, _ := newService(Config{DataDir: t.TempDir(), ReceiveDir: t.TempDir()}, true, 0)
		s.allowLocal = false
		if err := s.Connect(raw); err == nil {
			t.Fatalf("accepted %s", raw)
		}
		_ = s.TryClose()
	}
}
func TestHistorySurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	s, _ := newService(Config{DataDir: dir, ReceiveDir: t.TempDir()}, true, 0)
	s.mu.Lock()
	_ = s.addRecordLocked(Record{ID: "old", Status: "transferring", Name: "interrupted", Size: 42})
	s.mu.Unlock()
	again, err := newService(Config{DataDir: dir}, true, 0)
	if err != nil {
		t.Fatal(err)
	}
	if again.Snapshot().Records[0].Status != "interrupted" {
		t.Fatal("lost interruption")
	}
}
