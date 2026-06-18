package agent

// Proxy holds configuration for raw proxying to local services.
type Proxy struct {
	ChamberPort int // OpenChamber port (0 if not running)
}

func NewProxy(chamberPort int) *Proxy {
	return &Proxy{
		ChamberPort: chamberPort,
	}
}
