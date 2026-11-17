package peer

import (
	"context"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"io"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/quic-go/quic-go"
)

const maxProtocolMessageBytes = 128 << 10

const (
	quicFramePing   byte = 0
	quicFrameText   byte = byte(websocket.MessageText)
	quicFrameBinary byte = byte(websocket.MessageBinary)
)

type transportConn interface {
	ReadMessage(ctx context.Context) (websocket.MessageType, []byte, error)
	WriteMessage(ctx context.Context, kind websocket.MessageType, data []byte) error
	Ping(ctx context.Context) error
	CloseNow() error
	TLSState() *tls.ConnectionState
}

type wsTransport struct {
	conn *websocket.Conn
	tls  *tls.ConnectionState
}

func newWSTransport(conn *websocket.Conn, tlsState *tls.ConnectionState) *wsTransport {
	conn.SetReadLimit(maxProtocolMessageBytes)
	return &wsTransport{conn: conn, tls: tlsState}
}

func (t *wsTransport) ReadMessage(ctx context.Context) (websocket.MessageType, []byte, error) {
	return t.conn.Read(ctx)
}

func (t *wsTransport) WriteMessage(ctx context.Context, kind websocket.MessageType, data []byte) error {
	return t.conn.Write(ctx, kind, data)
}

func (t *wsTransport) Ping(ctx context.Context) error {
	return t.conn.Ping(ctx)
}

func (t *wsTransport) CloseNow() error {
	return t.conn.CloseNow()
}

func (t *wsTransport) TLSState() *tls.ConnectionState {
	return t.tls
}

// quicTransport adapts a single bidirectional QUIC stream to framed
// text/binary messages matching the WebSocket session protocol.
type quicTransport struct {
	conn    *quic.Conn
	stream  *quic.Stream
	writeMu sync.Mutex
}

func newQUICTransport(conn *quic.Conn, stream *quic.Stream) *quicTransport {
	return &quicTransport{conn: conn, stream: stream}
}

func (t *quicTransport) ReadMessage(ctx context.Context) (websocket.MessageType, []byte, error) {
	if deadline, ok := ctx.Deadline(); ok {
		_ = t.stream.SetReadDeadline(deadline)
		defer func() { _ = t.stream.SetReadDeadline(time.Time{}) }()
	}
	stop := context.AfterFunc(ctx, func() {
		_ = t.stream.SetReadDeadline(time.Now())
	})
	defer stop()

	var hdr [5]byte
	for {
		if _, err := io.ReadFull(t.stream, hdr[:]); err != nil {
			return 0, nil, err
		}
		frameType := hdr[0]
		size := binary.BigEndian.Uint32(hdr[1:5])
		if size > maxProtocolMessageBytes {
			return 0, nil, errors.New("消息大小超出限制")
		}
		if frameType == quicFramePing {
			if size > 0 {
				if _, err := io.CopyN(io.Discard, t.stream, int64(size)); err != nil {
					return 0, nil, err
				}
			}
			continue
		}
		if frameType != quicFrameText && frameType != quicFrameBinary {
			return 0, nil, errors.New("无效传输帧类型")
		}
		buf := make([]byte, size)
		if size > 0 {
			if _, err := io.ReadFull(t.stream, buf); err != nil {
				return 0, nil, err
			}
		}
		return websocket.MessageType(frameType), buf, nil
	}
}

func (t *quicTransport) WriteMessage(ctx context.Context, kind websocket.MessageType, data []byte) error {
	return t.writeFrame(ctx, byte(kind), data)
}

func (t *quicTransport) Ping(ctx context.Context) error {
	return t.writeFrame(ctx, quicFramePing, nil)
}

func (t *quicTransport) writeFrame(ctx context.Context, frameType byte, data []byte) error {
	t.writeMu.Lock()
	defer t.writeMu.Unlock()

	if deadline, ok := ctx.Deadline(); ok {
		_ = t.stream.SetWriteDeadline(deadline)
		defer func() { _ = t.stream.SetWriteDeadline(time.Time{}) }()
	}
	stop := context.AfterFunc(ctx, func() {
		_ = t.stream.SetWriteDeadline(time.Now())
	})
	defer stop()

	buf := make([]byte, 5+len(data))
	buf[0] = frameType
	binary.BigEndian.PutUint32(buf[1:5], uint32(len(data)))
	copy(buf[5:], data)
	_, err := t.stream.Write(buf)
	return err
}

func (t *quicTransport) CloseNow() error {
	t.stream.CancelRead(0)
	_ = t.stream.Close()
	return t.conn.CloseWithError(0, "closed")
}

func (t *quicTransport) TLSState() *tls.ConnectionState {
	cs := t.conn.ConnectionState().TLS
	return &cs
}
