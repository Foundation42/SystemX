# Examples

## Simple Client

The `simple-client.ts` script demonstrates how to interact with the SystemX router.

```bash
# Start the router in a separate terminal
bun run src/server.ts

# Register an address that waits for calls
bun run examples/simple-client.ts --address callee@example.com

# In another terminal, register a caller and place a call
bun run examples/simple-client.ts --address caller@example.com --dial callee@example.com
```

Additional options:

- `--no-auto-answer` – require manual intervention to accept calls.
- `--message "hello"` – send a message immediately after the call connects.
- Set `SYSTEMX_URL` to point at a different router instance (defaults to `ws://localhost:8080`).

While a call is active, anything typed into the terminal is sent as a `MSG` payload to the peer.
