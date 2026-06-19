package agent

// Proxy holds configuration for raw proxying to local services.
type Proxy struct {
	WebPort int // the worker's local web UI port (whatever --web mode is running; 0 if none)
}

func NewProxy(webPort int) *Proxy {
	return &Proxy{
		WebPort: webPort,
	}
}
