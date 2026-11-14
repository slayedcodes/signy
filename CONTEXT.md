# Change Contract

A Producing Agent and a human agree on what a change will do before it's coded. Every gap between that agreement and the final change is shown to a human, who has to sign it off.

## Language

**Change Contract**:
A typed, machine-checkable statement of what one PR will and won't change. It is approved by a human before any code is written.
_Avoid_: Plan, spec, contract file

**Clause**:
One checkable statement inside a Change Contract. Each Clause covers one thing, such as a scope, an interface, a dependency, a test, or something that must not change.
_Avoid_: Rule, item, requirement

**Deviation**:
Any difference between the Change Contract and the final change, in either direction. It covers something in the change that no Clause allows (an **Unplanned Change**) and a Clause the change doesn't fulfil (an **Unmet Clause**).
_Avoid_: Drift, violation, scope creep

**Unplanned Change**:
A Deviation where the change contains something that no Clause allows.

**Unmet Clause**:
A Deviation where a Clause promised something the change doesn't contain.

**Contract Approval**:
A human's recorded agreement to one exact Contract Version, given before any code is written.

**Contract Commit**:
The first commit of an Agent-authored PR. It adds exactly one Change Contract and nothing else.

**Approval Commit**:
An empty commit pushed by the gate bot that records a Contract Approval in git history. Only commits after it may contain code.
_Avoid_: Approval marker, sign commit

**Contract Version**:
One exact content state of a Change Contract. A change of scope means a new Contract Version, and it needs a fresh Contract Approval.
_Avoid_: Amendment

**Sign-off**:
A human's recorded decision on one Deviation. It is either **Accept** (a reason is required) or **Reject** (the change must be reworked). A Sign-off can never change the Change Contract.
_Avoid_: Approval (that word is reserved for the PR as a whole)

**Deviation Fingerprint**:
The identity of one Deviation, made of its kind, its target and its content. A Sign-off stays valid only while the fingerprint is unchanged.

**Sign-off Policy**:
A team's rule for who may give Sign-offs and Contract Approvals. By default this is any human with write access, except the PR author.

**Producing Agent**:
Whatever AI coding agent wrote the change. Any agent can be one; nothing in this context assumes a particular one.
_Avoid_: Bot, Claude, Copilot

**Agent-authored PR**:
A PR whose change was written by a Producing Agent. Every Agent-authored PR requires a Change Contract.
