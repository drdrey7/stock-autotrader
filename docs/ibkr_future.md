# Future IBKR interface — not implemented

V5.1 contains no IBKR dependency, credentials, Gateway, paper account, order endpoint or trading action.

A future broker adapter must live behind the private VPS engine and implement a narrow interface such as account snapshot, positions, order preview, submit and cancel. The public Worker and frontend must never import it or receive broker credentials.

Before implementation, require a separate threat model, paper-only approval, explicit kill switch, idempotency keys, reconciliation, maximum notional controls, broker-side permissions, audit logging and a manual rollout. Deterministic risk policy remains authoritative; AI may never size or approve an order.

