package tunnel

// Tunnel message types
const (
	TypeRegister       = "register"
	TypeHeartbeat      = "heartbeat"
	TypeError          = "error"
	TypeKillInstance   = "kill_instance"
	TypeFatalDuplicate = "fatal_duplicate"

	// Raw proxy — bidirectional byte stream to a local port (for WebSocket upgrades, HTTP, SSE, etc.)
	TypeRawProxy = "raw_proxy"
)

// BaseMessage represents the common envelope for all tunnel frames.
type BaseMessage struct {
	Type      string `json:"type"`
	RequestID string `json:"request_id,omitempty"`
	WorkerID  string `json:"worker_id,omitempty"`
}

// RegisterMessage is sent by the worker to register with the controller.
type RegisterMessage struct {
	BaseMessage
	WorkerName string `json:"worker_name"`
	Version    string `json:"version"`
}

// HeartbeatMessage is sent periodically by the worker.
type HeartbeatMessage struct {
	BaseMessage
	Timestamp string `json:"timestamp"`
}

// ErrorMessage indicates an error in proxying.
type ErrorMessage struct {
	BaseMessage
	Code    string `json:"code"`
	Message string `json:"message"`
}

// RawProxyMessage requests raw bidirectional proxying to a local port (for WebSocket upgrades).
type RawProxyMessage struct {
	BaseMessage
	Port int `json:"port"`
}
