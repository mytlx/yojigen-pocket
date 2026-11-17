package peer

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"math/big"
	"net/netip"
	"strings"
)

const (
	punchTokenPrefix  = "PK2"
	punchTokenVersion = 2
	flagEncrypted     = 0x01
	pbkdf2Iterations  = 10000
	base58Alphabet    = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
)

const (
	natUnknown   uint8 = 0
	natCone      uint8 = 1
	natSymmetric uint8 = 2
)

const (
	candLANv4  uint8 = 1
	candIPv6   uint8 = 2
	candSTUNv4 uint8 = 3
)

var (
	ErrPINRequired = errors.New("对方口令已加密，请输入提取码")
	ErrInvalidPIN  = errors.New("提取码错误或口令已损坏")
)

var base58Index = func() [256]int8 {
	var idx [256]int8
	for i := range idx {
		idx[i] = -1
	}
	for i, c := range base58Alphabet {
		idx[c] = int8(i)
	}
	return idx
}()

type PunchCandidate struct {
	Kind uint8
	Addr netip.AddrPort
}

type PunchToken struct {
	Version      uint8
	Encrypted    bool
	NATType      uint8
	RoleSeed     uint64
	SessionToken [12]byte
	Candidates   []PunchCandidate
}

func natTypeString(n uint8) string {
	switch n {
	case natCone:
		return "cone"
	case natSymmetric:
		return "symmetric"
	default:
		return "unknown"
	}
}

func EncodePunchToken(t PunchToken, pin string) (string, error) {
	pin = strings.TrimSpace(pin)
	if len(t.Candidates) == 0 || len(t.Candidates) > 8 {
		return "", errors.New("没有可用的连接候选地址")
	}
	plain, err := marshalPunchPayload(t)
	if err != nil {
		return "", err
	}
	var salt [8]byte
	if _, err = rand.Read(salt[:]); err != nil {
		return "", err
	}
	flags := (t.NATType & 0x03) << 1
	if pin != "" {
		flags |= flagEncrypted
	}
	var body []byte
	if pin != "" {
		body, err = sealTokenWithPIN(punchTokenVersion, flags, salt[:], plain, pin)
		if err != nil {
			return "", err
		}
	} else {
		obfs := xorObfuscate(salt[:], plain)
		tag := tokenTag(flags, salt[:], plain)
		body = make([]byte, 0, len(obfs)+4)
		body = append(body, obfs...)
		body = append(body, tag[:]...)
	}
	out := make([]byte, 0, 2+len(salt)+len(body))
	out = append(out, punchTokenVersion, flags)
	out = append(out, salt[:]...)
	out = append(out, body...)
	return punchTokenPrefix + encodeBase58(out), nil
}

func InspectPunchToken(raw string) (bool, error) {
	raw = cleanTokenInput(raw)
	b, err := decodeRawToken(raw)
	if err != nil {
		return false, err
	}
	return b[1]&flagEncrypted != 0, nil
}

func DecodePunchToken(raw, pin string) (PunchToken, error) {
	raw = cleanTokenInput(raw)
	pin = strings.TrimSpace(pin)
	b, err := decodeRawToken(raw)
	if err != nil {
		return PunchToken{}, err
	}
	version, flags := b[0], b[1]
	salt := b[2:10]
	body := b[10:]
	encrypted := flags&flagEncrypted != 0
	var plain []byte
	if encrypted {
		if pin == "" {
			return PunchToken{}, ErrPINRequired
		}
		plain, err = openTokenWithPIN(version, flags, salt, body, pin)
		if err != nil {
			return PunchToken{}, err
		}
	} else {
		if len(body) < 4 {
			return PunchToken{}, errors.New("打洞口令校验失败，可能复制不完整")
		}
		obfs := body[:len(body)-4]
		tag := body[len(body)-4:]
		plain = xorObfuscate(salt, obfs)
		want := tokenTag(flags, salt, plain)
		if !bytes.Equal(tag, want[:]) {
			return PunchToken{}, errors.New("打洞口令校验失败，可能复制不完整")
		}
	}
	tok, err := unmarshalPunchPayload(plain)
	if err != nil {
		return PunchToken{}, err
	}
	tok.Version = version
	tok.Encrypted = encrypted
	tok.NATType = (flags >> 1) & 0x03
	return tok, nil
}

func cleanTokenInput(raw string) string {
	return strings.TrimSpace(raw)
}

func decodeRawToken(raw string) ([]byte, error) {
	if !strings.HasPrefix(raw, punchTokenPrefix) {
		return nil, errors.New("打洞口令格式无效，应以 PK2 开头")
	}
	b, ok := decodeBase58(raw[len(punchTokenPrefix):])
	if !ok || len(b) < 14 {
		return nil, errors.New("打洞口令格式无效，请确认已完整复制")
	}
	if b[0] != punchTokenVersion {
		return nil, errors.New("打洞口令版本不兼容，请升级扩展")
	}
	return b, nil
}

func marshalPunchPayload(t PunchToken) ([]byte, error) {
	buf := make([]byte, 0, 21+len(t.Candidates)*19)
	var seed [8]byte
	binary.BigEndian.PutUint64(seed[:], t.RoleSeed)
	buf = append(buf, seed[:]...)
	buf = append(buf, t.SessionToken[:]...)
	buf = append(buf, byte(len(t.Candidates)))
	for _, c := range t.Candidates {
		if !c.Addr.IsValid() || c.Addr.Port() == 0 {
			return nil, errors.New("候选地址无效")
		}
		ip := c.Addr.Addr().Unmap()
		var port [2]byte
		binary.BigEndian.PutUint16(port[:], c.Addr.Port())
		if ip.Is4() {
			buf = append(buf, c.Kind, 4)
			buf = append(buf, port[:]...)
			a4 := ip.As4()
			buf = append(buf, a4[:]...)
		} else if ip.Is6() {
			buf = append(buf, c.Kind, 16)
			buf = append(buf, port[:]...)
			a16 := ip.As16()
			buf = append(buf, a16[:]...)
		} else {
			return nil, errors.New("不支持的地址类型")
		}
	}
	return buf, nil
}

func unmarshalPunchPayload(b []byte) (PunchToken, error) {
	if len(b) < 21 {
		return PunchToken{}, errors.New("打洞口令内容损坏")
	}
	var t PunchToken
	t.RoleSeed = binary.BigEndian.Uint64(b[0:8])
	copy(t.SessionToken[:], b[8:20])
	count := int(b[20])
	pos := 21
	if count == 0 || count > 8 {
		return PunchToken{}, errors.New("打洞口令缺少有效连接地址")
	}
	t.Candidates = make([]PunchCandidate, 0, count)
	for i := 0; i < count; i++ {
		if pos+4 > len(b) {
			return PunchToken{}, errors.New("打洞口令地址列表损坏")
		}
		kind := b[pos]
		ipLen := int(b[pos+1])
		port := binary.BigEndian.Uint16(b[pos+2 : pos+4])
		pos += 4
		if (ipLen != 4 && ipLen != 16) || pos+ipLen > len(b) || port == 0 {
			return PunchToken{}, errors.New("打洞口令地址解析失败")
		}
		ip, ok := netip.AddrFromSlice(b[pos : pos+ipLen])
		if !ok {
			return PunchToken{}, errors.New("打洞口令地址解析失败")
		}
		pos += ipLen
		t.Candidates = append(t.Candidates, PunchCandidate{
			Kind: kind,
			Addr: netip.AddrPortFrom(ip, port),
		})
	}
	if pos != len(b) {
		return PunchToken{}, errors.New("打洞口令存在多余数据")
	}
	return t, nil
}

func xorObfuscate(salt, data []byte) []byte {
	out := make([]byte, len(data))
	var counter [4]byte
	for off, block := 0, uint32(0); off < len(data); off, block = off+32, block+1 {
		binary.BigEndian.PutUint32(counter[:], block)
		h := sha256.New()
		_, _ = h.Write([]byte("pocket-peer-obfs-v2"))
		_, _ = h.Write(salt)
		_, _ = h.Write(counter[:])
		sum := h.Sum(nil)
		for i := 0; i < 32 && off+i < len(data); i++ {
			out[off+i] = data[off+i] ^ sum[i]
		}
	}
	return out
}

func tokenTag(flags byte, salt, plain []byte) [4]byte {
	h := sha256.New()
	_, _ = h.Write([]byte("pocket-peer-tag-v2"))
	_, _ = h.Write([]byte{flags})
	_, _ = h.Write(salt)
	_, _ = h.Write(plain)
	sum := h.Sum(nil)
	var out [4]byte
	copy(out[:], sum[:4])
	return out
}

func sealTokenWithPIN(version, flags byte, salt, plain []byte, pin string) ([]byte, error) {
	key, err := pbkdf2.Key(sha256.New, pin, salt, pbkdf2Iterations, 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := gcmNonce(salt)
	return gcm.Seal(nil, nonce[:], plain, []byte{version, flags}), nil
}

func openTokenWithPIN(version, flags byte, salt, ciphertext []byte, pin string) ([]byte, error) {
	key, err := pbkdf2.Key(sha256.New, pin, salt, pbkdf2Iterations, 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(ciphertext) < gcm.Overhead() {
		return nil, ErrInvalidPIN
	}
	nonce := gcmNonce(salt)
	plain, err := gcm.Open(nil, nonce[:], ciphertext, []byte{version, flags})
	if err != nil {
		return nil, ErrInvalidPIN
	}
	return plain, nil
}

func gcmNonce(salt []byte) [12]byte {
	h := sha256.New()
	_, _ = h.Write([]byte("pocket-peer-nonce-v2"))
	_, _ = h.Write(salt)
	sum := h.Sum(nil)
	var nonce [12]byte
	copy(nonce[:], sum[:12])
	return nonce
}

func DerivePairKey(a, b [12]byte) [32]byte {
	first, second := a[:], b[:]
	if bytes.Compare(first, second) > 0 {
		first, second = second, first
	}
	h := sha256.New()
	_, _ = h.Write([]byte("pocket-peer-punch-pair-v1"))
	_, _ = h.Write(first)
	_, _ = h.Write(second)
	var key [32]byte
	copy(key[:], h.Sum(nil))
	return key
}

func IsDialer(selfSeed uint64, selfTok [12]byte, peerSeed uint64, peerTok [12]byte) bool {
	if selfSeed != peerSeed {
		return selfSeed > peerSeed
	}
	return bytes.Compare(selfTok[:], peerTok[:]) > 0
}

func encodeBase58(data []byte) string {
	x := new(big.Int).SetBytes(data)
	base := big.NewInt(58)
	mod := new(big.Int)
	var out []byte
	for x.Sign() > 0 {
		x.QuoRem(x, base, mod)
		out = append(out, base58Alphabet[mod.Int64()])
	}
	for _, b := range data {
		if b != 0 {
			break
		}
		out = append(out, base58Alphabet[0])
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return string(out)
}

func decodeBase58(s string) ([]byte, bool) {
	if s == "" {
		return nil, false
	}
	x := new(big.Int)
	base := big.NewInt(58)
	for i := 0; i < len(s); i++ {
		val := base58Index[s[i]]
		if val < 0 {
			return nil, false
		}
		x.Mul(x, base)
		x.Add(x, big.NewInt(int64(val)))
	}
	raw := x.Bytes()
	zeros := 0
	for zeros < len(s) && s[zeros] == base58Alphabet[0] {
		zeros++
	}
	if zeros == 0 {
		return raw, true
	}
	out := make([]byte, zeros+len(raw))
	copy(out[zeros:], raw)
	return out, true
}
