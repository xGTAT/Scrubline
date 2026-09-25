# Scrubline Sample Web Fixture

A minimal, zero-dependency two-state web application fixture used to test Scrubline's source checkpoint capture and isolated historical preview capabilities.

## Architecture

- **State A (Baseline)**: Initial landing state with interactive counter and `#baseline` tagged feature component.
- **State B (Agent Modified)**: Modified feature state updated during agent edit cycles.
- **Zero-Dependency Server**: Implemented with native Node.js `http` module to guarantee fast, deterministic startup across isolated test worktrees without `node_modules` overhead.

## Setup & Running

### Requirements
- Node.js >= 18.0.0

### Run the Default Server
```bash
# Starts on default port 4100
npm start
# or
node server.js
```

### Run on a Custom Port (e.g. for Isolated Previews)
```bash
node server.js --port 4101
# or using environment variable
PORT=4102 node server.js
```

### Accessing the Web App
Open your browser at `http://localhost:4100` (or the configured port).
