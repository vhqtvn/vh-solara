package tunnel

import (
	"encoding/json"
	"testing"
)

func TestRegisterMessage(t *testing.T) {
	msg := RegisterMessage{
		BaseMessage: BaseMessage{
			Type:     TypeRegister,
			WorkerID: "w-1",
		},
		WorkerName: "Worker 1",
		Version:    "1.0",
	}

	b, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("Failed to marshal: %v", err)
	}

	var base BaseMessage
	if err := json.Unmarshal(b, &base); err != nil {
		t.Fatalf("Failed to unmarshal to base: %v", err)
	}

	if base.Type != TypeRegister {
		t.Errorf("Expected type %s, got %s", TypeRegister, base.Type)
	}

	var decoded RegisterMessage
	if err := json.Unmarshal(b, &decoded); err != nil {
		t.Fatalf("Failed to unmarshal to struct: %v", err)
	}

	if decoded.WorkerName != "Worker 1" {
		t.Errorf("Expected Worker 1, got %s", decoded.WorkerName)
	}
}

func TestErrorMessage(t *testing.T) {
	msg := FormatError("req-1", "ERR_TEST", "something failed: %s", "details")
	if msg.Type != TypeError {
		t.Errorf("Expected type error, got %s", msg.Type)
	}
	if msg.Message != "something failed: details" {
		t.Errorf("Unexpected message: %s", msg.Message)
	}
}
