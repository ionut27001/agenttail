# Contributing

Thanks for considering a contribution.

1. Use Node 24 or newer.
2. `npm install` for the development-only tools (the runtime itself has no dependencies).
3. Make the change with synthetic fixtures only. Do not commit real session logs, screenshots of real sessions, local paths or config files.
4. Run `npm test`; it starts throwaway servers on loopback and drives headless Edge for the UI suite.
5. Keep the runtime dependency-free and every request local.

By submitting a contribution you agree that it is licensed under the MIT
License in this repository.
