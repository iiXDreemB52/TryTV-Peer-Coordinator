# TryTV P2P coordination service

Small Node.js HTTPS/WSS peer rendezvous and transient relay. It stores no source packs, private user information or catalog; all bundles are verified by the existing TryTV SourceSync Ed25519 client. `Dreem` authenticates with challenge-response using its local private key; the key never leaves the computer. Peer announcements are not authoritative source approvals.

Transport order: local verified pack cache / LAN P2P → internet P2P → Dreem owner → GitHub API and raw immutable assets.

No Cloudflare services, R2 or Vercel are used. Set `PORT` for a Node 20+ deployment; health check `/healthz`, public counts `/status`. Memory-only coordinator; no durable state. Bounded request rate, concurrent transfers, sockets and bytes.

Note: free-tier infrastructure may sleep when idle; fallback to GitHub continues to work. Client participation can be disabled without affecting playback or library data.
