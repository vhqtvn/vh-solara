package state

import (
	"bytes"
	"encoding/json"
)

// tree_node.go implements the server-owned tree wire contract — the Node schema
// (§3 of docs/design/server-owned-tree.md) and the structural-delta op types
// (§4). These are the cross-version contract between the Go server (Phase 2)
// and the TypeScript client (Phase 3): the client decodes these verbatim and
// applies ops literally, so the JSON field names, optionality, and shapes MUST
// match the design doc exactly.
//
// The types are self-contained: they carry no legacy projection-layer
// bookkeeping (the Node schema is independent of how rows are aggregated or
// projected — §3.2). The emitter (tree_emitter.go) populates them from the
// existing store + subtree indexes; it does NOT rebuild the tree.

// VerbFacet (defined in store.go:790) is reused as the Node.verb shape —
// {tool, state?}. A nil *VerbFacet on Node means "no active tool facet" (omitted
// on the wire); the verb CLEAR sentinel on a facet op is FacetVerb (below).

// Node is one row of the server-owned session tree (§3). It is self-contained:
// every field needed to render the row (title, agent chip, activity, flags, the
// ▸ N expand affordance) travels with the node, so a collapsed placeholder needs
// no follow-up fetch to display.
type Node struct {
	ID              string     `json:"id"`
	ParentID        string     `json:"-"` // "" = root; emitted as null via MarshalJSON
	Title           string     `json:"title"`
	Agent           string     `json:"agent,omitempty"`           // OPTIONAL (§3): absent = no chip.
	Activity        string     `json:"activity"`                  // idle|busy|retry|error (SELF, not subtree).
	Verb            *VerbFacet `json:"verb,omitempty"`            // OPTIONAL (§3): absent = no active tool facet.
	ChildCount      int        `json:"childCount"`                // DIRECT children (structural; drives expand).
	DescendantCount *int       `json:"descendantCount,omitempty"` // OPTIONAL (§3): TOTAL descendants badge.
	Loaded          bool       `json:"loaded"`                    // server: are this node's direct children shipped?
	Flags           NodeFlags  `json:"flags"`
	UpdatedMs       int64      `json:"updatedMs"` // Session.time.updated, unix ms.
}

// NodeFlags is the discrete facet set (§3). These replace the opaque
// aggregateState of the old CollapsedBranchStub (projection.go:21) with
// explicit booleans so a collapsed node renders its own pins/badges.
type NodeFlags struct {
	PendingInput      bool `json:"pendingInput"`      // SELF: question set + unanswered.
	SubtreeNeedsInput bool `json:"subtreeNeedsInput"` // SUBTREE aggregate (the ONE retained badge, Q2).
	Permission        bool `json:"permission"`        // SELF: permissions[id] non-empty.
	Archived          bool `json:"archived"`          // session archived facet.
	Orphan            bool `json:"orphan"`            // SERVER-COMPUTED ONLY (§9).
}

// MarshalJSON emits parentId as null when the node is a root (ParentID==""),
// matching §3 ("null = root"). All other fields use their struct tags.
func (n Node) MarshalJSON() ([]byte, error) {
	type alias Node // avoid recursion; alias drops MarshalJSON.
	a := struct {
		alias
		ParentID *string `json:"parentId"`
	}{alias: alias(n)}
	if n.ParentID != "" {
		pid := n.ParentID
		a.ParentID = &pid
	}
	return json.Marshal(a)
}

// UnmarshalJSON accepts both null and a string for parentId (null → root).
func (n *Node) UnmarshalJSON(raw []byte) error {
	type alias Node
	var a struct {
		alias
		ParentID *string `json:"parentId"`
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&a); err != nil {
		return err
	}
	*n = Node(a.alias)
	if a.ParentID != nil {
		n.ParentID = *a.ParentID
	}
	return nil
}

// ----------------------------------------------------------------------------
// Delta ops (§4)
// ----------------------------------------------------------------------------

// TreeOp is one structural delta op wrapped in the §4.1 envelope. The emitter
// assigns a monotonic seq (INV-A) via assignSeq before marshaling, and orders
// ops parent-before-child within a flush (INV-B).
type TreeOp interface {
	json.Marshaler
	Op() string
	Seq() uint64
	assignSeq(seq uint64)
	setDir(string)
	setSessionHint(string)
}

// opEnvelope is the §4.1 wire envelope shared by every op.
type opEnvelope struct {
	Dir       string      `json:"dir,omitempty"`
	Seq       uint64      `json:"seq"`
	SessionID string      `json:"sessionId,omitempty"`
	Op        string      `json:"op"`
	Data      interface{} `json:"data"`
}

// baseOp carries the per-op envelope fields the emitter stamps after building
// an op (seq from the monotonic counter; dir/session hint from context).
type baseOp struct {
	seq         uint64
	dir         string
	sessionHint string
}

func (b *baseOp) assignSeq(seq uint64)    { b.seq = seq }
func (b *baseOp) Seq() uint64             { return b.seq }
func (b *baseOp) setDir(d string)         { b.dir = d }
func (b *baseOp) setSessionHint(s string) { b.sessionHint = s }

func (b baseOp) envelope(op string, data interface{}) opEnvelope {
	return opEnvelope{Dir: b.dir, Seq: b.seq, SessionID: b.sessionHint, Op: op, Data: data}
}

// --- node.upsert (§4.2) ---

type nodeUpsertData struct {
	Node Node `json:"node"`
}

// NodeUpsert is the node.upsert op (full Node replace).
type NodeUpsert struct {
	baseOp
	Node Node
}

// NodeUpsertOp constructs a node.upsert for the given node.
func NodeUpsertOp(n Node) *NodeUpsert { return &NodeUpsert{Node: n} }

func (o *NodeUpsert) Op() string { return "node.upsert" }
func (o *NodeUpsert) MarshalJSON() ([]byte, error) {
	return json.Marshal(o.envelope("node.upsert", nodeUpsertData{Node: o.Node}))
}

// --- node.remove (§4.3) ---

type nodeRemoveData struct {
	ID string `json:"id"`
}

// NodeRemove is the node.remove op (drop node + loaded descendants).
type NodeRemove struct {
	baseOp
	ID string
}

// NodeRemoveOp constructs a node.remove for the given id.
func NodeRemoveOp(id string) *NodeRemove { return &NodeRemove{ID: id} }

func (o *NodeRemove) Op() string { return "node.remove" }
func (o *NodeRemove) MarshalJSON() ([]byte, error) {
	return json.Marshal(o.envelope("node.remove", nodeRemoveData{ID: o.ID}))
}

// --- node.move (§4.4) ---

type nodeMoveData struct {
	ID          string  `json:"id"`
	NewParentID *string `json:"newParentId"` // null = moved to root.
}

// NodeMove is the node.move op (reparent). NewParentID=="" means root.
type NodeMove struct {
	baseOp
	ID          string
	NewParentID string
}

// NodeMoveOp constructs a node.move. newParentID=="" means root (null on wire).
func NodeMoveOp(id, newParentID string) *NodeMove {
	return &NodeMove{ID: id, NewParentID: newParentID}
}

func (o *NodeMove) Op() string { return "node.move" }
func (o *NodeMove) MarshalJSON() ([]byte, error) {
	d := nodeMoveData{ID: o.ID}
	if o.NewParentID != "" {
		np := o.NewParentID
		d.NewParentID = &np
	}
	return json.Marshal(o.envelope("node.move", d))
}

// --- node.children (§4.5) ---

type nodeChildrenData struct {
	ParentID string `json:"parentId"`
	Nodes    []Node `json:"nodes"`
	HasMore  bool   `json:"hasMore"`
	Cursor   string `json:"cursor,omitempty"` // absent when hasMore=false.
}

// NodeChildren is the node.children op (expand result / server push of a batch).
type NodeChildren struct {
	baseOp
	ParentID string
	Nodes    []Node
	HasMore  bool
	Cursor   string
}

// NodeChildrenOp constructs a node.children. cursor=="" is omitted when
// hasMore is false (terminal batch).
func NodeChildrenOp(parentID string, nodes []Node, hasMore bool, cursor string) *NodeChildren {
	return &NodeChildren{ParentID: parentID, Nodes: nodes, HasMore: hasMore, Cursor: cursor}
}

func (o *NodeChildren) Op() string { return "node.children" }
func (o *NodeChildren) MarshalJSON() ([]byte, error) {
	d := nodeChildrenData{ParentID: o.ParentID, Nodes: o.Nodes, HasMore: o.HasMore, Cursor: o.Cursor}
	return json.Marshal(o.envelope("node.children", d))
}

// --- node.facet (§4.6) ---

// FacetVerb is the tri-state verb field of a facet op: zero value = omit,
// ClearVerb() = emit verb:null (clears the active tool), SetVerb(v) = set.
type FacetVerb struct {
	clear bool
	facet *VerbFacet
}

// ClearVerb returns a FacetVerb that emits `"verb":null` (clears the facet).
func ClearVerb() FacetVerb { return FacetVerb{clear: true} }

// SetVerb returns a FacetVerb that sets the active tool facet to v.
func SetVerb(v VerbFacet) FacetVerb { return FacetVerb{facet: &v} }

// IsZero reports whether the FacetVerb should be omitted from the wire.
func (f FacetVerb) IsZero() bool { return !f.clear && f.facet == nil }

// FacetData is the node.facet op data (§4.6). Every field except ID is optional;
// a partial merge applies only the listed fields. Flags is a partial map so the
// client merges only the changed keys (omitted flags are untouched — §4.6).
type FacetData struct {
	ID       string          `json:"id"`
	Activity *string         `json:"activity,omitempty"` // nil = untouched.
	Verb     FacetVerb       `json:"-"`                  // tri-state; marshaled below.
	Flags    map[string]bool `json:"-"`                  // partial; marshaled below.
}

// MarshalJSON emits activity/verb/flags with precise tri-state / partial
// semantics. A nil field is OMITTED (untouched); a present field is applied.
func (d FacetData) MarshalJSON() ([]byte, error) {
	m := map[string]interface{}{"id": d.ID}
	if d.Activity != nil {
		m["activity"] = *d.Activity
	}
	if !d.Verb.IsZero() {
		if d.Verb.clear {
			m["verb"] = nil
		} else {
			m["verb"] = d.Verb.facet
		}
	}
	if len(d.Flags) > 0 {
		m["flags"] = d.Flags
	}
	return json.Marshal(m)
}

// NodeFacet is the node.facet op (lightweight facet-only update).
type NodeFacet struct {
	baseOp
	Data FacetData
}

// NodeFacetOp constructs a node.facet.
func NodeFacetOp(id string, data FacetData) *NodeFacet {
	data.ID = id
	return &NodeFacet{Data: data}
}

func (o *NodeFacet) Op() string { return "node.facet" }
func (o *NodeFacet) MarshalJSON() ([]byte, error) {
	return json.Marshal(o.envelope("node.facet", o.Data))
}
