package peer

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
)

const maxFileSize int64 = 1 << 40
const chunkSize = 64 << 10

type incomingFile struct {
	id, name, temp string
	file           *os.File
	hash           hash.Hash
	size, done     int64
}

func safeName(name string) (string, error) {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\:\x00") || len([]rune(name)) > 180 {
		return "", errors.New("不安全的文件名")
	}
	name = strings.TrimRightFunc(name, func(r rune) bool { return r == '.' || unicode.IsSpace(r) })
	if name == "" {
		return "", errors.New("文件名为空")
	}
	for _, r := range name {
		if unicode.IsControl(r) || strings.ContainsRune(`<>"|?*`, r) {
			return "", errors.New("文件名包含不支持的字符")
		}
	}
	stem := strings.ToUpper(strings.SplitN(name, ".", 2)[0])
	switch stem {
	case "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9":
		name = "_" + name
	}
	return name, nil
}
func (s *Service) addRecordLocked(r Record) error {
	old := append([]Record{}, s.records...)
	// Never evict records of in-flight files.
	if len(s.records) >= 200 {
		for i := len(s.records) - 1; i >= 0; i-- {
			if s.records[i].Status != "transferring" && s.records[i].Status != "queued" && s.records[i].Status != "verifying" {
				s.records = append(s.records[:i], s.records[i+1:]...)
				break
			}
		}
	}
	s.records = append([]Record{r}, s.records...)
	if err := s.saveLocked(); err != nil {
		s.records = old
		return err
	}
	return nil
}
func (s *Service) recordLocked(id string) *Record {
	for i := range s.records {
		if s.records[i].ID == id {
			return &s.records[i]
		}
	}
	return nil
}
func (s *Service) progress(id string, n int64, status string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r := s.recordLocked(id); r != nil {
		r.Done = n
		r.Status = status
		seconds := float64(time.Now().UnixMilli()-r.Started) / 1000
		if seconds > 0 {
			r.Speed = float64(n) / seconds
		}
	}
}
func (s *Service) complete(id, status, path string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r := s.recordLocked(id); r != nil {
		r.Status = status
		r.Path = path
		r.Temp = ""
		r.Finished = time.Now().UnixMilli()
		r.Speed = 0
		if err != nil {
			r.Error = err.Error()
		}
		if status == "completed" {
			r.Done = r.Size
		}
	}
	s.active--
	if e := s.saveLocked(); e != nil {
		s.lastError = "保存传输记录失败：" + e.Error()
	}
}

// Send accepts only native picker/drop paths; the host does not expose arbitrary
// path reads to extension JavaScript. Files are streamed sequentially per peer.
func (s *Service) Send(paths []string) error {
	if len(paths) == 0 {
		return nil
	}
	if len(paths) > 100 {
		return errors.New("一次最多选择 100 个文件")
	}
	infos := make([]os.FileInfo, len(paths))
	for i, p := range paths {
		info, err := os.Stat(p)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return errors.New("请选择文件；文件夹请先压缩")
		}
		if info.Size() > maxFileSize {
			return errors.New("单个文件不能超过 1 TB")
		}
		if _, err = safeName(info.Name()); err != nil {
			return err
		}
		infos[i] = info
	}
	s.mu.Lock()
	p := s.current
	if s.closed || p == nil || p.state != "connected" {
		s.mu.Unlock()
		return errors.New("请先完成数字验证并建立连接")
	}
	if p.sending {
		s.mu.Unlock()
		return errors.New("已有发送队列，请等待完成")
	}
	ids := make([]string, len(paths))
	old := append([]Record{}, s.records...)
	for i, info := range infos {
		ids[i] = randomID()
		r := Record{ID: ids[i], Name: info.Name(), Size: info.Size(), Direction: "send", Status: "queued", Peer: p.remote.Name, Started: time.Now().UnixMilli(), Path: paths[i]}
		if err := s.addRecordLocked(r); err != nil {
			s.records = old
			_ = s.saveLocked()
			s.mu.Unlock()
			return err
		}
	}
	p.sending = true
	s.active += len(paths)
	s.mu.Unlock()
	go func() {
		defer func() { s.mu.Lock(); p.sending = false; s.mu.Unlock() }()
		var failed error
		for i, path := range paths {
			if failed == nil {
				failed = p.sendFile(ids[i], path, infos[i].Size())
			}
			if failed != nil {
				s.complete(ids[i], "failed", path, failed)
				p.cancel()
				_ = p.conn.CloseNow()
			} else {
				s.complete(ids[i], "completed", path, nil)
			}
		}
	}()
	return nil
}
func (p *session) waitAck(id, kind string) (message, error) {
	timer := time.NewTimer(60 * time.Second)
	defer timer.Stop()
	select {
	case <-p.ctx.Done():
		return message{}, errors.New("连接中断或传输已取消")
	case <-timer.C:
		return message{}, errors.New("等待对方确认超时")
	case m := <-p.ack:
		if m.ID != id {
			return m, errors.New("文件确认不匹配")
		}
		if m.Type == "file-error" {
			return m, errors.New(m.Error)
		}
		if m.Type != kind {
			return m, errors.New("文件确认顺序错误")
		}
		return m, nil
	}
}
func (p *session) sendFile(id, path string, size int64) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if info.Size() != size || !info.Mode().IsRegular() {
		return errors.New("文件已改变，请重新选择")
	}
	s := p.service
	s.mu.Lock()
	if r := s.recordLocked(id); r != nil {
		r.Started = time.Now().UnixMilli()
	}
	s.mu.Unlock()
	s.progress(id, 0, "transferring")
	if err = p.write(message{Type: "file", ID: id, Name: filepath.Base(path), Size: size}); err != nil {
		return err
	}
	if _, err = p.waitAck(id, "file-ready"); err != nil {
		return err
	}
	h := sha256.New()
	buf := make([]byte, 32+chunkSize)
	copy(buf, id)
	var done int64
	for done < size {
		n := int64(chunkSize)
		if size-done < n {
			n = size - done
		}
		if _, err = io.ReadFull(f, buf[32:32+n]); err != nil {
			return err
		}
		_, _ = h.Write(buf[32 : 32+n])
		if err = p.writeBytes(2, buf[:32+n]); err != nil {
			return err
		}
		done += n
		s.progress(id, done, "transferring")
	}
	digest := hex.EncodeToString(h.Sum(nil))
	s.progress(id, done, "verifying")
	if err = p.write(message{Type: "file-end", ID: id, Hash: digest}); err != nil {
		return err
	}
	ack, err := p.waitAck(id, "file-done")
	if err != nil {
		return err
	}
	if ack.Hash != digest || ack.Size != size {
		return errors.New("对方文件校验不一致")
	}
	return nil
}
func (p *session) beginReceive(m message) error {
	if p.receive != nil {
		return errors.New("已有文件正在接收")
	}
	if len(m.ID) != 32 {
		return errors.New("无效文件标识")
	}
	if _, err := hex.DecodeString(m.ID); err != nil {
		return err
	}
	name, err := safeName(m.Name)
	if err != nil {
		return err
	}
	if m.Size < 0 || m.Size > maxFileSize {
		return errors.New("文件大小超出限制")
	}
	s := p.service
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return errors.New("传输服务已关闭")
	}
	if s.recordLocked(m.ID) != nil {
		s.mu.Unlock()
		return errors.New("重复文件标识")
	}
	folder := s.folder
	s.active++
	s.mu.Unlock()
	fail := func(err error) error {
		s.mu.Lock()
		s.active--
		s.mu.Unlock()
		_ = p.write(message{Type: "file-error", ID: m.ID, Error: "无法创建接收文件，请检查文件夹和磁盘空间"})
		return err
	}
	if err = os.MkdirAll(folder, 0700); err != nil {
		return fail(err)
	}
	f, err := os.CreateTemp(folder, ".pocket-*.part")
	if err != nil {
		return fail(err)
	}
	s.mu.Lock()
	err = s.addRecordLocked(Record{ID: m.ID, Name: name, Size: m.Size, Direction: "receive", Status: "transferring", Peer: p.remote.Name, Started: time.Now().UnixMilli(), Temp: f.Name()})
	s.mu.Unlock()
	if err != nil {
		f.Close()
		os.Remove(f.Name())
		return fail(err)
	}
	p.receive = &incomingFile{id: m.ID, name: name, temp: f.Name(), file: f, hash: sha256.New(), size: m.Size}
	return p.write(message{Type: "file-ready", ID: m.ID})
}
func (p *session) receiveChunk(data []byte) error {
	f := p.receive
	if f == nil || len(data) < 32 || string(data[:32]) != f.id {
		return errors.New("未授权的文件数据")
	}
	body := data[32:]
	if len(body) > chunkSize || f.done+int64(len(body)) > f.size {
		return errors.New("文件数据超出声明大小")
	}
	if _, err := f.file.Write(body); err != nil {
		return err
	}
	_, _ = f.hash.Write(body)
	f.done += int64(len(body))
	p.service.progress(f.id, f.done, "transferring")
	return nil
}
func (p *session) abortReceive(reason string) {
	f := p.receive
	if f == nil {
		return
	}
	p.receive = nil
	_ = f.file.Close()
	_ = os.Remove(f.temp)
	p.service.complete(f.id, "interrupted", "", errors.New(reason))
}
func (p *session) endReceive(m message) error {
	f := p.receive
	if f == nil || m.ID != f.id {
		return errors.New("文件结束消息不匹配")
	}
	sum := hex.EncodeToString(f.hash.Sum(nil))
	if f.done != f.size || sum != m.Hash {
		return errors.New("文件完整性校验失败")
	}
	p.service.progress(f.id, f.done, "verifying")
	if err := f.file.Sync(); err != nil {
		return err
	}
	if err := f.file.Close(); err != nil {
		return err
	}
	path, err := commitFile(f.temp, f.name)
	if err != nil {
		return err
	}
	p.receive = nil
	err = p.write(message{Type: "file-done", ID: m.ID, Hash: sum, Size: f.size})
	p.service.complete(f.id, "completed", path, nil)
	return err
}

// Link publishes a fully verified file without ever overwriting an existing
// name. Filesystems without hard links fall back to an exclusive copy.
func commitFile(temp, name string) (string, error) {
	dir := filepath.Dir(temp)
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 0; i < 10000; i++ {
		candidate := name
		if i > 0 {
			candidate = fmt.Sprintf("%s (%d)%s", stem, i, ext)
		}
		target := filepath.Join(dir, candidate)
		err := os.Link(temp, target)
		if err == nil {
			_ = os.Remove(temp)
			return target, nil
		}
		if os.IsExist(err) {
			continue
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if os.IsExist(err) {
			continue
		}
		if err != nil {
			return "", err
		}
		in, err := os.Open(temp)
		if err == nil {
			_, err = io.Copy(out, in)
			_ = in.Close()
		}
		if err == nil {
			err = out.Sync()
		}
		if e := out.Close(); err == nil {
			err = e
		}
		if err != nil {
			_ = os.Remove(target)
			return "", err
		}
		_ = os.Remove(temp)
		return target, nil
	}
	return "", errors.New("同名文件过多，请更换接收文件夹")
}
