import { QUALITY, settings } from './store.js';

/**
 * Full-mesh WebRTC audio: every member of a channel holds one peer connection
 * to every other member. Voice never touches the server, which keeps latency at
 * LAN levels (typically 1–5 ms) and the server load near zero.
 *
 * Mesh is the right shape here because channels are small. Bandwidth per client
 * is (n-1) x ~50 kbps, so a 10-person channel costs about 450 kbps up — nothing
 * on wired or modern Wi-Fi.
 */
export class Mesh extends EventTarget {
  constructor(net, audio) {
    super();
    this.net = net;
    this.audio = audio;
    this.peers = new Map(); // id -> {pc, polite, queue, stats, failures}
    this.statsTimer = setInterval(() => this.pollStats(), 3000);
  }

  get selfId() {
    return this.net.selfId;
  }

  /** No STUN or TURN: on a LAN, host candidates connect directly. */
  rtcConfig() {
    return {
      iceServers: [],
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 0
    };
  }

  /** Brings the connection set in line with who is in the channel. */
  sync(peerIds) {
    const wanted = new Set(peerIds);
    for (const id of [...this.peers.keys()]) {
      if (!wanted.has(id)) this.drop(id);
    }
    for (const id of wanted) {
      if (!this.peers.has(id)) this.connect(id);
    }
  }

  /**
   * Deterministic roles avoid offer glare without a full perfect-negotiation
   * dance: the lexicographically larger id always makes the offer.
   */
  isInitiator(id) {
    return (this.selfId ?? '') > id;
  }

  connect(id) {
    const pc = new RTCPeerConnection(this.rtcConfig());
    const entry = { pc, queue: [], stats: {}, failures: 0, id };
    this.peers.set(id, entry);

    const track = this.audio.outboundTrack;
    if (track) pc.addTrack(track, this.audio.outboundStream);
    else pc.addTransceiver('audio', { direction: 'sendrecv' });

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.net.send({ t: 'signal', to: id, payload: { candidate: ev.candidate.toJSON() } });
      }
    };

    pc.ontrack = async (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      await this.audio.addPeer(id, stream);
      this.dispatchEvent(new CustomEvent('peer-audio', { detail: { id } }));
    };

    pc.onconnectionstatechange = () => {
      this.dispatchEvent(
        new CustomEvent('peer-state', { detail: { id, state: pc.connectionState } })
      );
      if (pc.connectionState === 'failed') this.recover(id);
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'disconnected') {
        // Give it a moment; Wi-Fi roams recover on their own.
        setTimeout(() => {
          if (pc.iceConnectionState === 'disconnected') this.recover(id);
        }, 2500);
      }
    };

    pc.onnegotiationneeded = async () => {
      if (!this.isInitiator(id)) return;
      await this.makeOffer(id).catch((err) => console.warn('rtc: offer failed', err));
    };

    if (this.isInitiator(id)) this.makeOffer(id).catch(() => {});
    return entry;
  }

  async makeOffer(id) {
    const entry = this.peers.get(id);
    if (!entry || entry.pc.signalingState !== 'stable') return;
    const offer = await entry.pc.createOffer();
    offer.sdp = this.tuneSDP(offer.sdp);
    await entry.pc.setLocalDescription(offer);
    this.net.send({ t: 'signal', to: id, payload: { sdp: entry.pc.localDescription } });
    this.applySenderBitrate(entry.pc);
  }

  async handleSignal(from, payload) {
    let entry = this.peers.get(from);
    if (!entry) entry = this.connect(from);
    const { pc } = entry;

    try {
      if (payload.sdp) {
        const desc = new RTCSessionDescription(payload.sdp);
        if (desc.type === 'offer') {
          // We only answer when we are not the designated offerer, so a
          // collision cannot happen in normal operation.
          await pc.setRemoteDescription(desc);
          const answer = await pc.createAnswer();
          answer.sdp = this.tuneSDP(answer.sdp);
          await pc.setLocalDescription(answer);
          this.net.send({ t: 'signal', to: from, payload: { sdp: pc.localDescription } });
          this.applySenderBitrate(pc);
        } else if (desc.type === 'answer' && pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(desc);
          this.applySenderBitrate(pc);
        }
        // Candidates that arrived before the description are now safe to add.
        for (const c of entry.queue.splice(0)) {
          await pc.addIceCandidate(c).catch(() => {});
        }
      } else if (payload.candidate) {
        const candidate = new RTCIceCandidate(payload.candidate);
        if (pc.remoteDescription?.type) await pc.addIceCandidate(candidate).catch(() => {});
        else entry.queue.push(candidate);
      }
    } catch (err) {
      console.warn('rtc: signal handling failed', err);
    }
  }

  /**
   * Opus knobs the browser does not expose through an API. In-band FEC costs a
   * little bandwidth and buys a lot of resilience on congested Wi-Fi.
   */
  tuneSDP(sdp) {
    const q = QUALITY[settings.quality] ?? QUALITY.normal;
    const opts = [
      'stereo=0',
      'sprop-stereo=0',
      `maxaveragebitrate=${q.bitrate}`,
      'useinbandfec=1',
      `usedtx=${q.dtx ? 1 : 0}`,
      'maxplaybackrate=48000'
    ].join(';');

    return sdp
      .split('\r\n')
      .map((line) => {
        if (/^a=fmtp:\d+ .*(minptime|useinbandfec)/.test(line) || /^a=fmtp:111/.test(line)) {
          const [head] = line.split(' ');
          return `${head} minptime=10;${opts}`;
        }
        return line;
      })
      .join('\r\n');
  }

  applySenderBitrate(pc) {
    const q = QUALITY[settings.quality] ?? QUALITY.normal;
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== 'audio') continue;
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = q.bitrate;
      params.encodings[0].networkPriority = 'high';
      params.encodings[0].priority = 'high';
      sender.setParameters(params).catch(() => {});
    }
  }

  /** Re-apply quality to every live connection without renegotiating. */
  refreshQuality() {
    for (const { pc } of this.peers.values()) this.applySenderBitrate(pc);
  }

  /** Swaps the outbound track after a mic change — no renegotiation needed. */
  async replaceTrack(track) {
    for (const { pc } of this.peers.values()) {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind === 'audio') await sender.replaceTrack(track).catch(() => {});
      }
    }
  }

  recover(id) {
    const entry = this.peers.get(id);
    if (!entry) return;
    entry.failures++;
    if (entry.failures <= 2 && this.isInitiator(id)) {
      try {
        entry.pc.restartIce();
        this.makeOffer(id).catch(() => {});
        return;
      } catch {
        /* fall through to a full rebuild */
      }
    }
    // Rebuild from scratch; the roster sync will re-add it.
    this.drop(id);
    setTimeout(() => {
      if (!this.peers.has(id)) this.connect(id);
    }, 600);
  }

  async pollStats() {
    for (const [id, entry] of this.peers) {
      try {
        const report = await entry.pc.getStats();
        const s = { rtt: null, loss: null, jitter: null, bitrate: null, kind: null };
        let inbound = null;
        report.forEach((r) => {
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null) {
            s.rtt = Math.round(r.currentRoundTripTime * 1000);
          }
          if (r.type === 'inbound-rtp' && r.kind === 'audio') inbound = r;
          if (r.type === 'local-candidate' && r.candidateType) s.kind = r.candidateType;
        });
        if (inbound) {
          s.jitter = inbound.jitter != null ? Math.round(inbound.jitter * 1000) : null;
          const received = inbound.packetsReceived ?? 0;
          const lost = inbound.packetsLost ?? 0;
          s.loss = received + lost > 0 ? +((lost / (received + lost)) * 100).toFixed(1) : 0;
          const prev = entry.stats._bytes ?? 0;
          const bytes = inbound.bytesReceived ?? 0;
          s.bitrate = Math.max(0, Math.round(((bytes - prev) * 8) / 3000));
          s._bytes = bytes;
        }
        entry.stats = s;
      } catch {
        /* connection went away mid-poll */
      }
    }
    this.dispatchEvent(new CustomEvent('stats', { detail: this.summary() }));
  }

  summary() {
    const out = {};
    for (const [id, entry] of this.peers) {
      out[id] = { ...entry.stats, state: entry.pc.connectionState };
    }
    return out;
  }

  drop(id) {
    const entry = this.peers.get(id);
    if (!entry) return;
    try {
      entry.pc.getSenders().forEach((s) => s.track && s.track.kind === 'video' && s.track.stop());
      entry.pc.onicecandidate = null;
      entry.pc.ontrack = null;
      entry.pc.close();
    } catch {
      /* already closed */
    }
    this.peers.delete(id);
    this.audio.removePeer(id);
  }

  closeAll() {
    for (const id of [...this.peers.keys()]) this.drop(id);
  }

  destroy() {
    clearInterval(this.statsTimer);
    this.closeAll();
  }
}
