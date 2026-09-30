
---
Task ID: 12
Agent: main (Z.ai Code)
Task: Fix the intermittent "stuck at 100% after transferring" bug + add UI messaging telling users to keep both phones on during transfer (and that the sender showing "done" doesn't mean the receiver is done).

Work Log:
- Cloned https://github.com/AaronS6/beam into /tmp/beam and traced the full transfer pipeline (signaling server -> webrtc.ts -> use-beam-session.ts -> sender/receiver panels).
- Synced the beam project into /home/z/my-project, ran `bun install`, started `bun run dev` (port 3000) + the signaling mini-service (port 3003, via `bun --hot`).
- Identified the REMAINING root causes of "stuck at 100%" that the previous 11-bug patch did not catch:
  * RC1 (CRITICAL): `entry.count = Math.max(entry.count, chunkIndex + 1)` tracked the HIGHEST chunk index, NOT the number of received chunks. With unordered reliable delivery the highest-index chunk can land before earlier ones, so `count == expectedCount` while `received < size`. finalizeFile's poll `while (entry.count < entry.expectedCount)` then exited early, reassembled a PARTIAL blob, set `entry.finalized = true`, and SUPPRESSED the auto-finalize when the missing chunks finally arrived.
  * RC2 (CRITICAL, user-reported): the sender fired `onAllComplete` immediately after `ctrl.send("done")`. The receiver could still be draining late chunks + running finalizeFile. The sender's UI showed "All sent" while the receiver was mid-transfer; if the user closed the sender phone on that signal, the WebRTC connection tore down and the receiver got stranded at 100% with no Download button.
  * RC3 (HIGH): the receiver's `done` handler called `void this.finalizeFile(seq)` (async, not awaited) then immediately fired `onAllComplete`. The receiver's phase flipped to "done" while each file was still "transferring" at 100% with no Download button (the exact stuck-at-100% symptom).
  * RC4 (MEDIUM): finalizeFile's 3s poll ceiling was too short for slow networks, and its condition was wrong (see RC1).
- Fixed webrtc.ts:
  * Added a `receivedChunks` counter to the incoming entry (real count, distinct from `count` which is just the reassembly upper bound). Incremented per chunk in handleChunkMessage.
  * Added a new `all-received` control message (RECEIVER -> SENDER ack) sent only AFTER all finalizeFile calls have completed (blobs built + URLs created).
  * Rewrote finalizeFile's poll: `while (received < size && receivedChunks < expectedCount && now < deadline)` with a 10s ceiling. No longer exits on the misleading `count`.
  * Rewrote the `done` handler: collect all finalizeFile promises, `await Promise.all(...)`, THEN send `all-received` to the sender, THEN fire onAllComplete. So the receiver's phase only flips to "done" once every file truly has a real blob URL.
  * Rewrote the sender's sendQueuedFiles: after `ctrl.send("done")`, fire `onSenderFinishing` (new callback -> UI "finishing" state), then `await awaitReceiverAck()` (resolves on the ack, a 20s fallback, or channel close). Only fire onAllComplete if `ok === true` (ack or timeout), NOT on channel close (let onChannelClose/onFailed drive the error UI so the sender doesn't lie "done" after a peer-left).
  * Added awaitReceiverAck()/resolveAck() + ackResolver/ackTimer/ackOnClose/ackCtrl fields; cleared them in close() so teardown settles the promise as not-ok.
  * Made handleControlMessage async to support the awaited `done` sweep.
- Wired the hook (use-beam-session.ts):
  * Added `finishing: boolean` to SessionState + INITIAL.
  * `t.onSenderFinishing = () => patch({ finishing: true })`.
  * Reset `finishing: false` in onChannelOpen (new transfer) and onAllComplete (wait is over).
  * The receiver's onAllComplete safety net (5s setTimeout) is kept as a backstop, but the primary path now completes correctly because finalizeFile is awaited.
- Added UI messaging (sender-panel.tsx + receiver-panel.tsx):
  * SENDER transferring: if `finishing`, the stage shows "Finishing up on {peer}" + "Almost done — the other device is saving your files. Keep this app open." and the speed label swaps to "finishing…". A prominent primary-tinted banner shows "Don't close this app yet — Beam is still delivering the last pieces to the other device. Closing this app or locking your phone can interrupt the transfer." If not finishing, a standard banner shows "Keep both phones on — Keep both phones unlocked and this app open until the transfer finishes. Closing either device can interrupt it."
  * RECEIVER transferring: a "Keep both phones on" banner explaining to keep the app open + both phones unlocked until every file shows "Ready to save", and that closing either device (or the sender leaving early) can leave files stuck at 100%.
  * SENDER done: heading changed "All sent" -> "All delivered" + new subtext "The receiver confirmed every file arrived safely." (only renders now because onAllComplete fires after the ack).
  * RECEIVER done: banner heading changed "Press Save to download" -> "All files arrived — press Download to save" + body now notes "the sender has been told you're all set".
- Verified with agent-browser via the Caddy gateway (port 81, where the ?XTransformPort=3003 socket.io routing actually works):
  * Small file (56 B): sender idle -> upload -> QR waiting -> receiver tab opens -> receiver "Receiving files" -> "All yours" + new "All files arrived" banner. Sender shows "All delivered" + "The receiver confirmed every file arrived safely." -> proves the all-received ack flowed receiver->sender and the sender waited for it.
  * Large file (5 MB): receiver showed "Receiving files" + "Keep both phones on" banner during the ~3s transfer, then "All yours" + "All files arrived — press Download to save". Sender ended on "All delivered".
  * `bun run lint`: 0 errors (1 pre-existing unrelated font warning in layout.tsx).
  * dev.log: clean compiles, all routes 200, no runtime/hydration errors.
  * signaling.log: full session lifecycle (create-session -> join-session -> signal relay).
  * Browser errors console: empty on both tabs.

Stage Summary:
- Root cause of the residual "stuck at 100%": (a) the chunk-counting bug made finalizeFile reassemble partial blobs and then suppress the real auto-finalize, and (b) the sender declared "done" before the receiver had finished, so users closed the sender phone mid-transfer and stranded the receiver.
- Fix: a true receiver->sender `all-received` ack gate. The sender now shows a "finishing up — keep this app open" state and only flips to "All delivered" once the receiver confirms every file is finalized. The receiver's `done` handler now AWAITS finalizeFile before announcing completion, so files never sit at 100% + "transferring" + no Download button.
- New in-app messaging on BOTH phones during transfer: "Keep both phones on" / "Don't close this app yet" — directly addresses the user's request to tell people to keep all phones on during the process and that the sender saying done doesn't mean the receiver is done (now it literally can't say done until the receiver confirms).
- Files changed: src/lib/webrtc.ts, src/hooks/use-beam-session.ts, src/components/beam/sender-panel.tsx, src/components/beam/receiver-panel.tsx.

---
Task ID: 13
Agent: main (Z.ai Code)
Task: Investigate why the peer-to-peer connection takes so long to establish, and shorten it without introducing reliability/performance issues.

Work Log:
- Audited the full connection-time budget: (a) socket.io connect handshake (~100-300ms), (b) signaling offer/answer round-trips through the signaling server, (c) ICE candidate gathering — host candidates are instant, server-reflexive (srflx) candidates need a STUN round-trip, (d) ICE connectivity checks, (e) SCTP/data-channel open after ICE connects.
- Found the previous config used a SINGLE STUN server (stun:stun.l.google.com:19302) and a bare `new RTCPeerConnection({ iceServers })` with no ICE pre-warming and no transport bundling. On mobile networks Google's STUN can take 500ms-2s+, and any slowness at that one endpoint directly delayed every connection.
- Confirmed the signaling server runs on Render's FREE tier (render.yaml: `plan: free`) which sleeps after 15 min idle and takes ~30s to wake on the next request — this is the biggest real-world contributor to "Connecting…" taking a long time and is why the receiver panel already has a "Waking up the server…" hint after 15s.
- Implemented the safe, standard WebRTC optimizations in src/lib/webrtc.ts (no throughput/reliability tradeoffs):
  * getIceServers(): added Cloudflare STUN (stun:stun.cloudflare.com:3478) alongside Google. Both are anycast + free; the browser queries them IN PARALLEL and uses the fastest srflx response, and has redundancy if one is slow/down.
  * RTCPeerConnection config: `iceCandidatePoolSize: 10` — pre-warms the ICE agent so the FIRST connection doesn't wait to spin up candidate-gathering slots (shaves a few hundred ms with zero downside).
  * RTCPeerConnection config: `bundlePolicy: "max-bundle"` — bundles all 4 data channels (ctrl + 3 data) over a SINGLE ICE transport instead of one per channel. The browser only gathers candidates + runs connectivity checks for ONE transport, not four — the single biggest negotiation speedup for a data-only connection. The 4 channels still get full bandwidth (SCTP multiplexes streams within one transport).
- Did NOT change (deliberate): the 3-data-channel count (parallelism helps large-file throughput; reducing it would trade connection speed for transfer speed — not worth it), the 30s ICE hard ceiling (kept as a safety bound), the trickle-ICE flow (already optimal — offer sent immediately, candidates trickle), the 16KB chunk size, or the TURN env-var support (kept for restrictive networks).
- Verified with agent-browser via port 81: small-file transfer connected in ~1.3s, sender showed "All delivered" + "The receiver confirmed every file arrived safely." (ack flow intact), no console/runtime errors, clean signaling log (create-session -> join-lobby -> join-session). `bun run lint`: 0 errors.

Stage Summary:
- Code-side speedups applied (all safe, no throughput/reliability cost): multiple anycast STUN servers queried in parallel, ICE candidate pre-warming (iceCandidatePoolSize), and single-transport bundling (bundlePolicy: max-bundle). Together these cut the WebRTC-negotiation portion of "Connecting…" by avoiding the single-STUN round-trip stall and the per-channel ICE duplication.
- The LARGEST remaining real-world contributor is NOT in code: the signaling server on Render's free tier sleeps after 15 min idle and takes ~30s to wake. Fix options for the user: (1) upgrade the beam-signaling Render service to a paid plan so it never sleeps (~$7/mo), or (2) add a free cron job (e.g. cron-job.org / GitHub Actions / UptimeRobot) that pings https://<signaling-url>/health every 10 minutes to keep it warm. The lobby client already keeps it warm while anyone has Beam open; the cold start only bites the first user after a 15+ min gap.
- Files changed: src/lib/webrtc.ts (getIceServers + ensurePC).
