//go:build e2e

package peer

// NewLoopback is available only in automation builds, never in release builds.
func NewLoopback(cfg Config) (*Service, error)          { return newService(cfg, true, 0) }
func (s *Service) ConnectLoopback(other *Service) error { return s.connectTo("::1", other.port) }
