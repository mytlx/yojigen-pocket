package peer

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/coder/websocket"
)

// Bind the human check to this TLS channel. Commit before accepting the
// listener's nonce so neither side gets to choose its input after seeing
// the other's and search for a desired four-digit display.
func (p *session) pairingNumber(listener bool) (string, error) {
	channel, err := p.conn.TLSState().ExportKeyingMaterial("pocket-peer-pairing-v2", nil, 32)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(p.ctx, 10*time.Second)
	defer cancel()
	type frame struct {
		Type string
		Data []byte
	}
	send := func(kind string, data []byte) error {
		b, err := json.Marshal(frame{kind, data})
		if err != nil {
			return err
		}
		return p.conn.WriteMessage(ctx, websocket.MessageText, b)
	}
	read := func(kind string) ([]byte, error) {
		mt, b, err := p.conn.ReadMessage(ctx)
		if err != nil {
			return nil, err
		}
		var f frame
		if mt != websocket.MessageText || len(b) > 512 || json.Unmarshal(b, &f) != nil || f.Type != kind || len(f.Data) != 32 {
			return nil, errors.New("配对协议不匹配，请双方更新口袋直传")
		}
		return f.Data, nil
	}
	commit := func(n []byte) [32]byte { return sha256.Sum256(append(bytes.Clone(channel), n...)) }
	mine := make([]byte, 32)
	rand.Read(mine)
	var initiator, responder []byte
	if listener {
		c, err := read("commit")
		if err != nil {
			return "", err
		}
		responder = mine
		if err = send("nonce", responder); err != nil {
			return "", err
		}
		initiator, err = read("open")
		if err != nil {
			return "", err
		}
		expected := commit(initiator)
		if !bytes.Equal(expected[:], c) {
			return "", errors.New("配对校验失败")
		}
	} else {
		initiator = mine
		c := commit(initiator)
		if err = send("commit", c[:]); err != nil {
			return "", err
		}
		responder, err = read("nonce")
		if err != nil {
			return "", err
		}
		if err = send("open", initiator); err != nil {
			return "", err
		}
	}
	digest := sha256.Sum256(append(append(channel, initiator...), responder...))
	return fmt.Sprintf("%04d", binary.BigEndian.Uint64(digest[:8])%10000), nil
}

// service.mu protects these flags. Only a local UI action sets localConfirmed.
func (p *session) finishPairingLocked() {
	if !p.localConfirmed || !p.remoteConfirmed {
		return
	}
	p.state = "connected"
	p.code = ""
	p.expires = time.Time{}
	if p.timer != nil {
		p.timer.Stop()
	}
}
