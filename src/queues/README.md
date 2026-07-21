# Queue consumers

Async message flow (spec section 3):

```
signal-evaluation -> order-execution -> fill-events
```

Planned, none implemented yet. Consumers must be idempotent: a redelivered
message is checked against the Durable Object's own storage before acting,
so a retry looks up an existing order by `clientOrderId` rather than placing
a duplicate (section 5.1).
