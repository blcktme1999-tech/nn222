(function (scope) {
  'use strict';

  // Share the SDK's single autoplay callback without stealing another session's hook.
  const autoplayHubs = new WeakMap();
  function watchAutoplay(sdk, listener) {
    let hub = autoplayHubs.get(sdk);
    if (!hub) {
      hub = { previous: sdk.onAutoplayFailed, listeners: new Set() };
      hub.handler = (...args) => {
        try { if (typeof hub.previous === 'function') hub.previous.apply(sdk, args); } catch (_) { /* External callback. */ }
        for (const callback of hub.listeners) callback(...args);
      };
      sdk.onAutoplayFailed = hub.handler;
      autoplayHubs.set(sdk, hub);
    }
    hub.listeners.add(listener);
    return () => {
      hub.listeners.delete(listener);
      if (!hub.listeners.size) {
        if (sdk.onAutoplayFailed === hub.handler) sdk.onAutoplayFailed = hub.previous;
        autoplayHubs.delete(sdk);
      }
    };
  }

  function cancelled() {
    const error = new Error('視訊操作已取消。');
    error.name = 'AbortError';
    return error;
  }

  /**
   * Receive-only until setDevice()/publishBoth() is called. No recording.
   * tracks is Map<'video'|'audio', published Agora local track>.
   * Public operation failures reject AND notify onError; AbortError only rejects.
   * onChange receives this controller (zero-argument callbacks also work).
   * The host owns videoGrid, the local tile/player/label, and remotePlaceholder.
   */
  class ReportVideoSession {
    constructor({ getToken, onChange = () => {}, onError = () => {} } = {}) {
      if (typeof getToken !== 'function') throw new TypeError('getToken 必須是函式。');
      this.getToken = getToken;
      this.onChange = onChange;
      this.onError = onError;
      this.caseId = null;
      this.root = null;
      this.client = null;
      this.tracks = new Map();
      this.preferredCameraId = '';
      this.cameraLabel = '';
      this.connected = false;
      this.busy = false;
      this.status = 'idle';
      this.lastError = null;
      this.audioBlocked = false;
      this._epoch = 0;
      this._deviceEpoch = 0;
      this._pending = 0;
      this._queue = Promise.resolve();
      this._session = null;
    }

    get hasLocalMedia() { return this.tracks.size > 0; }

    _change() {
      try { this.onChange(this); } catch (_) { /* UI callbacks cannot break cleanup. */ }
    }

    _error(error) {
      if (error && error.name === 'AbortError') return;
      const alreadyReported = this.lastError === error;
      this.lastError = error;
      this.status = 'error';
      if (this._session) this._refreshStatus(this._session);
      this._change();
      if (alreadyReported) return;
      try { this.onError(error); } catch (_) { /* Consumer handles its own errors. */ }
    }

    _enqueue(operation, epoch = this._epoch) {
      this._pending += 1;
      this.busy = true;
      const result = this._queue.then(operation).catch((error) => {
        if (epoch === this._epoch) this._error(error);
        throw error;
      }).finally(() => {
        this._pending -= 1;
        this.busy = this._pending > 0;
        this._change();
      });
      // Install the tail before notifying UI, including reentrant callbacks.
      this._queue = result.catch(() => {});
      this._change();
      return result;
    }

    _active(session) {
      return this._session === session && session.epoch === this._epoch;
    }

    _usable(session) {
      return this._active(session) && !session.failed;
    }

    _check(session) {
      if (!this._usable(session)) throw cancelled();
    }

    _checkDevice(session, deviceEpoch) {
      this._check(session);
      if (!this.connected || deviceEpoch !== this._deviceEpoch) throw cancelled();
    }

    _refreshStatus(session) {
      if (!this._active(session)) return;
      this.status = session.failed ? session.failureStatus : !this.connected
        ? (session.connectionState === 'CONNECTED' ? 'connecting' : session.connectionState.toLowerCase())
        : this.lastError ? 'error' : 'connected';
    }

    _failConnection(session, error, status = 'error') {
      if (!this._usable(session)) return;
      session.failed = true;
      session.connectionError = error;
      session.failureStatus = status;
      this._deviceEpoch += 1;
      this.connected = false;
      // Release consented devices immediately, but leave only from queued cleanup.
      // Agora may emit DISCONNECTED inside leave(); never call leave from an event.
      for (const track of session.owned) this._close(session, track);
      this.tracks.clear();
      this._localPlayer()?.replaceChildren();
      this._render(session);
      this._error(error);
    }

    _connectionState(session, state, reason) {
      session.connectionState = state;
      if (state === 'DISCONNECTED') {
        const error = new Error(`視訊連線已中斷${reason ? `（${reason}）` : ''}，請重新連線。`);
        error.code = 'CONNECTION_DISCONNECTED';
        this._failConnection(session, error, 'disconnected');
        return;
      }
      this.connected = state === 'CONNECTED' && session.joined;
      this._refreshStatus(session);
      if (state === 'RECONNECTING' || state === 'DISCONNECTING') {
        this._deviceEpoch += 1;
        // Invalidate unfinished subscriptions; do not retry them on SDK recovery.
        for (const remote of session.remotes.values()) {
          for (const [kind, entry] of remote.media) {
            if (!entry.track) this._removeRemote(session, remote.uid, kind);
          }
        }
      }
      this._change();
    }

    _localPlayer(root = this.root) {
      if (!root) return null;
      const player = root.querySelector('[data-slot="localPlayer"]');
      const slot = root.querySelector('[data-slot="localVideoSlot"]');
      // Support either nesting order without deleting the host's wrapper.
      return player && slot && player.contains(slot) ? slot : player || slot;
    }

    _validateRoot(root) {
      if (!root || !root.querySelector || !root.querySelector('[data-slot="videoGrid"]') ||
          !root.querySelector('[data-slot="remotePlaceholder"]') || !this._localPlayer(root)) {
        throw new Error('視訊區塊缺少 videoGrid、localPlayer 或 remotePlaceholder。');
      }
    }

    async connect(caseId, root) {
      const epoch = this._epoch;
      return this._enqueue(async () => {
        if (epoch !== this._epoch) throw cancelled();
        this._validateRoot(root);
        if (caseId === null || caseId === undefined || caseId === '') throw new Error('缺少案件編號。');
        if (this.connected && this.caseId === caseId) {
          this._attachRoot(this._session, root);
          this._scanRemotes(this._session);
          return this;
        }
        await this._cleanup();
        if (epoch !== this._epoch) throw cancelled();
        const session = {
          epoch, caseId, client: null, sdk: null, auth: null, listeners: [],
          owned: new Set(), remotes: new Map(), pending: new Map(), renewing: null,
          subscriptionErrors: new Map(), connectionState: 'CONNECTING', joined: false, failed: false
        };
        this._session = session;
        this.caseId = caseId;
        this.root = root;
        this.status = 'connecting';
        this.lastError = null;
        this._change();
        try {
          session.sdk = scope.AgoraRTC;
          if (!session.sdk) throw new Error('Agora SDK 尚未載入。');
          const auth = await this.getToken(caseId);
          this._check(session);
          if (!auth || !auth.appId || !auth.channelName || auth.uid === null || auth.uid === undefined) {
            throw new Error('視訊授權資料不完整。');
          }
          session.auth = { ...auth };
          const client = session.sdk.createClient({ mode: 'rtc', codec: 'vp8' });
          session.client = this.client = client;
          this._listen(session, 'user-published', (user, media) => this._subscribe(session, user, media));
          this._listen(session, 'user-unpublished', (user, media) => this._removeRemote(session, user.uid, media));
          this._listen(session, 'user-left', (user) => this._removeRemote(session, user.uid));
          this._listen(session, 'token-privilege-will-expire', () => this._renew(session));
          this._listen(session, 'connection-state-change', (state, _previous, reason) =>
            this._connectionState(session, state, reason));
          this._listen(session, 'token-privilege-did-expire', () => {
            const error = new Error('視訊授權已過期，請重新連線。');
            error.code = 'TOKEN_EXPIRED';
            this._failConnection(session, error);
          });
          session.unwatch = watchAutoplay(session.sdk, () => {
            if (!this._usable(session)) return;
            const error = new Error('瀏覽器阻擋自動播放，請按播放聲音按鈕。');
            error.code = 'AUTOPLAY_BLOCKED';
            this._audioError(session, error);
          });
          await client.join(auth.appId, auth.channelName, auth.token, auth.uid);
          if (this._active(session) && session.failed) throw session.connectionError;
          this._check(session);
          if (session.connectionState === 'RECONNECTING' || session.connectionState === 'DISCONNECTING') {
            throw new Error('視訊連線尚未恢復，請重試。');
          }
          session.joined = true;
          session.connectionState = 'CONNECTED';
          this.connected = true;
          this._refreshStatus(session);
          this._render(session);
          // Joining never waits for remote subscriptions, which may stall independently.
          this._scanRemotes(session);
          this._change();
          return this;
        } catch (error) {
          const stale = !this._active(session);
          try { await this._cleanup(); } catch (cleanupError) {
            if (!stale) this._error(cleanupError);
          }
          throw stale ? cancelled() : error;
        }
      }, epoch);
    }

    async setDevice(kind, enabled) {
      const epoch = this._epoch;
      const deviceEpoch = this._deviceEpoch;
      return this._enqueue(async () => {
        if (epoch !== this._epoch) throw cancelled();
        if (enabled && deviceEpoch !== this._deviceEpoch) throw cancelled();
        if (kind !== 'video' && kind !== 'audio') throw new TypeError('裝置種類必須是 video 或 audio。');
        const session = this._session;
        if (!session || (enabled && !this.connected)) throw new Error('請先連線至視訊房間。');
        if (!this._active(session)) throw cancelled();
        // Revoking device consent must remain possible during SDK reconnection.
        if (enabled) this._check(session);
        const existing = this.tracks.get(kind);
        if (Boolean(enabled) === Boolean(existing)) return;
        if (!enabled) {
          try {
            await session.client.unpublish(existing);
            this._check(session);
          } finally {
            this.tracks.delete(kind);
            this._close(session, existing);
            if (kind === 'video') this._localPlayer()?.replaceChildren();
            if (this._active(session)) this._render(session);
          }
        } else {
          let track;
          let publishAttempted = false;
          try {
            track = await (kind === 'video'
              ? session.sdk.createCameraVideoTrack(this.preferredCameraId ? { cameraId: this.preferredCameraId } : { facingMode: 'user' })
              : session.sdk.createMicrophoneAudioTrack());
            session.owned.add(track);
            this._checkDevice(session, deviceEpoch);
            publishAttempted = true;
            await session.client.publish(track);
            this._checkDevice(session, deviceEpoch);
            this.tracks.set(kind, track);
            if (kind === 'video') this._rememberCamera(track);
          } catch (error) {
            if (track) {
              // A rejected publish may still have partially published at the SDK level.
              if (publishAttempted) {
                try { await session.client.unpublish(track); } catch (_) { /* Still close it. */ }
              }
              this.tracks.delete(kind);
              this._close(session, track);
            }
            throw this._usable(session) && deviceEpoch === this._deviceEpoch ? error : cancelled();
          }
        }
        if (this.connected) this.lastError = null;
        this._refreshStatus(session);
        this._render(session);
        if (kind === 'video' && enabled) {
          const track = this.tracks.get('video');
          this._playVideo(session, track, this._localPlayer(), () => this.tracks.get('video') === track);
        }
        this._change();
      }, epoch);
    }

    _rememberCamera(track) {
      if (track && typeof track.getTrackLabel === 'function') {
        const label = track.getTrackLabel();
        if (label) this.cameraLabel = label;
      }
      const deviceId = track?.getMediaStreamTrack?.()?.getSettings?.()?.deviceId;
      if (deviceId) this.preferredCameraId = deviceId;
    }

    async listCameras() {
      const devices = navigator.mediaDevices;
      if (!devices?.enumerateDevices) throw new Error('此瀏覽器無法選擇鏡頭');
      const read = async () => (await devices.enumerateDevices()).filter((item) => item.kind === 'videoinput');
      let cameras = await read();
      if (!cameras.length || cameras.every((item) => !item.label)) {
        const stream = await devices.getUserMedia({ video: true, audio: false });
        stream.getTracks().forEach((track) => track.stop());
        cameras = await read();
      }
      if (!cameras.length) throw new Error('找不到可用鏡頭');
      return cameras.map((item, index) => ({
        deviceId: item.deviceId,
        label: item.label || `鏡頭 ${index + 1}`
      }));
    }

    async useCamera(deviceId, label) {
      if (!deviceId) throw new Error('請選擇鏡頭');
      this.preferredCameraId = deviceId;
      if (label) this.cameraLabel = label;
      const epoch = this._epoch;
      return this._enqueue(async () => {
        if (epoch !== this._epoch) throw cancelled();
        const track = this.tracks.get('video');
        if (track && typeof track.setDevice === 'function') {
          await track.setDevice(deviceId);
          this._rememberCamera(track);
        }
        this._change();
      }, epoch);
    }

    async publishBoth() {
      // Independent requests: a missing camera must not prevent microphone use.
      const results = await Promise.allSettled([this.setDevice('video', true), this.setDevice('audio', true)]);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    }

    async disconnect() {
      // Invalidate in-flight join, capture, subscribe and renewal immediately.
      const epoch = ++this._epoch;
      this._deviceEpoch += 1;
      this.connected = false;
      this.status = 'disconnecting';
      return this._enqueue(async () => {
        await this._cleanup();
        if (epoch === this._epoch) {
          this.status = 'idle';
          this.lastError = null;
        }
      }, epoch);
    }

    _listen(session, event, callback) {
      const handler = (...args) => {
        if (!this._usable(session)) return;
        try {
          return Promise.resolve(callback(...args)).catch((error) => {
            if (this._usable(session)) this._error(error);
          });
        } catch (error) {
          if (this._usable(session)) this._error(error);
        }
      };
      session.listeners.push([event, handler]);
      session.client.on(event, handler);
    }

    _scanRemotes(session) {
      for (const user of session.client.remoteUsers || []) {
        if (user.hasVideo) this._subscribe(session, user, 'video');
        if (user.hasAudio) this._subscribe(session, user, 'audio');
      }
    }

    _subscriptionSucceeded(session, uid, kind) {
      const failures = session.subscriptionErrors;
      const previous = failures.get(uid)?.get(kind);
      failures.get(uid)?.delete(kind);
      if (!failures.get(uid)?.size) failures.delete(uid);
      // Only a real recovery clears this subscription's error, never unrelated
      // device/playback errors or failures belonging to another remote track.
      if (previous && this.lastError === previous) {
        this.lastError = [...failures.values()].flatMap((media) => [...media.values()]).pop() || null;
        this._refreshStatus(session);
      }
    }

    _subscribe(session, user, kind) {
      if (!this._usable(session) || (session.connectionState !== 'CONNECTING' && session.connectionState !== 'CONNECTED') ||
          (kind !== 'audio' && kind !== 'video')) return Promise.resolve();
      let remote = session.remotes.get(user.uid);
      if (!remote) {
        remote = { uid: user.uid, media: new Map(), tile: null, player: null, label: null };
        session.remotes.set(user.uid, remote);
      }
      if (remote.media.has(kind)) return remote.media.get(kind).promise;
      const entry = { track: null, promise: null };
      remote.media.set(kind, entry);
      const valid = () => this._usable(session) && session.remotes.get(user.uid) === remote && remote.media.get(kind) === entry;
      let pending = session.pending.get(user.uid);
      if (!pending) session.pending.set(user.uid, pending = new Map());
      // Serialize an unpublish/re-publish behind its obsolete subscribe, not behind
      // another participant or media kind. Old SDK completion cannot overwrite new tracks.
      const previous = pending.get(kind) || Promise.resolve();
      const task = previous.catch(() => {}).then(async () => {
        if (!valid()) return;
        await session.client.subscribe(user, kind);
        const track = user[`${kind}Track`];
        if (!valid()) {
          if (track) this._stop(track);
          return;
        }
        if (!track) throw new Error(`遠端 ${kind} 軌道尚未提供。`);
        entry.track = track;
        this._subscriptionSucceeded(session, user.uid, kind);
        this._render(session);
        if (kind === 'video') this._playVideo(session, track, remote.player, valid);
        else this._playAudio(session, track, valid);
        this._change();
      }).catch((error) => {
        if (!valid()) return;
        let failures = session.subscriptionErrors.get(user.uid);
        if (!failures) session.subscriptionErrors.set(user.uid, failures = new Map());
        failures.set(kind, error);
        this._removeRemote(session, user.uid, kind);
        this._error(error);
      }).finally(() => {
        if (pending.get(kind) === task) {
          pending.delete(kind);
          if (!pending.size && session.pending.get(user.uid) === pending) session.pending.delete(user.uid);
        }
      });
      entry.promise = task;
      pending.set(kind, task);
      this._render(session);
      this._change();
      return task;
    }

    _removeRemote(session, uid, kind) {
      const remote = session.remotes.get(uid);
      if (!remote) return;
      const kinds = kind === undefined ? [...remote.media.keys()] : [kind];
      for (const type of kinds) {
        const entry = remote.media.get(type);
        remote.media.delete(type); // Invalidate before a pending promise can settle.
        if (entry?.track) this._stop(entry.track);
        if (type === 'video') remote.player?.replaceChildren();
      }
      if (!remote.media.size) {
        remote.tile?.remove();
        session.remotes.delete(uid);
      }
      this._render(session);
      this._change();
    }

    _render(session) {
      if (!this._active(session) || !this.root) return;
      const grid = this.root.querySelector('[data-slot="videoGrid"]');
      for (const remote of session.remotes.values()) {
        if (!remote.tile) {
          const doc = this.root.ownerDocument;
          remote.tile = doc.createElement('div');
          remote.tile.className = 'video-tile';
          const slot = doc.createElement('div');
          slot.className = 'video-slot';
          remote.player = doc.createElement('div');
          remote.player.className = 'video-player';
          remote.label = doc.createElement('div');
          remote.label.className = 'video-label';
          slot.appendChild(remote.player);
          remote.tile.appendChild(slot);
          remote.tile.appendChild(remote.label);
          grid.appendChild(remote.tile);
        }
        const role = /^(agent|admin|staff)-/.test(String(remote.uid)) ? '客服' : '民眾';
        remote.label.textContent = role + (remote.media.has('video') ? '' : '（僅語音）');
      }
      this.root.querySelector('[data-slot="remotePlaceholder"]').hidden = session.remotes.size > 0;
      const localLabel = this.root.querySelector('[data-slot="localLabel"]') ||
        this._localPlayer()?.closest('.video-tile')?.querySelector('.video-label');
      if (localLabel) localLabel.textContent = this.tracks.has('video') ? '我方' :
        this.tracks.has('audio') ? '我方（僅語音）' : '我方（未開啟鏡頭／麥克風）';
    }

    _playVideo(session, track, element, valid = () => this._active(session)) {
      const current = () => this._usable(session) && this.root?.contains(element) && valid();
      if (!element || !current()) return;
      try {
        const result = track.play(element, { fit: 'contain' });
        for (const video of element.querySelectorAll('video')) {
          video.muted = true;
          video.autoplay = true;
          video.playsInline = true;
        }
        Promise.resolve(result).catch((error) => { if (current()) this._error(error); });
      } catch (error) { if (current()) this._error(error); }
    }

    _audioError(session, error) {
      this.audioBlocked = true;
      session.audioError = error;
      this._error(error);
    }

    _playAudio(session, track, valid = () => this._active(session)) {
      if (!this._usable(session) || !valid()) return Promise.resolve();
      const failed = (error) => {
        if (this._usable(session) && valid()) this._audioError(session, error);
      };
      try { return Promise.resolve(track.play()).catch(failed); } catch (error) {
        failed(error);
        return Promise.resolve();
      }
    }

    // Invoke directly from a click handler: play() runs before any await/queue so
    // browser user activation is preserved. The host can keep its button visible.
    async resumeAudio() {
      const session = this._session;
      if (!session || !this._usable(session) || !this.connected) return false;
      this.audioBlocked = false;
      const plays = [];
      for (const remote of session.remotes.values()) {
        const entry = remote.media.get('audio');
        if (entry?.track) plays.push(this._playAudio(session, entry.track,
          () => this._active(session) && remote.media.get('audio') === entry));
      }
      await Promise.all(plays);
      if (!this._usable(session) || !this.connected) return false;
      if (!this.audioBlocked && this.lastError === session.audioError) {
        this.lastError = null;
        this._refreshStatus(session);
      }
      this._change();
      return !this.audioBlocked;
    }

    _attachRoot(session, root) {
      if (this.root === root) return;
      const video = this.tracks.get('video');
      if (video) this._stop(video);
      for (const remote of session.remotes.values()) {
        const track = remote.media.get('video')?.track;
        if (track) this._stop(track);
      }
      this._clearRoot(session);
      this.root = root;
      this._render(session);
      if (video) this._playVideo(session, video, this._localPlayer(), () => this.tracks.get('video') === video);
      for (const remote of session.remotes.values()) {
        const entry = remote.media.get('video');
        if (entry?.track) this._playVideo(session, entry.track, remote.player,
          () => this._active(session) && remote.media.get('video') === entry);
      }
      this._change();
    }

    _renew(session) {
      if (session.renewing) return session.renewing;
      session.renewing = Promise.resolve().then(async () => {
        this._check(session);
        const auth = await this.getToken(session.caseId);
        this._check(session);
        if (!auth || auth.uid !== session.auth.uid || auth.channelName !== session.auth.channelName || auth.appId !== session.auth.appId) {
          throw new Error('更新授權的 UID 或頻道與目前連線不符。');
        }
        await session.client.renewToken(auth.token);
        this._check(session);
      }).catch((error) => {
        if (this._usable(session)) this._error(error);
      }).finally(() => { session.renewing = null; });
      return session.renewing;
    }

    _stop(track) {
      try { track.stop(); } catch (_) { /* Continue releasing other resources. */ }
    }

    _close(session, track) {
      if (!session.owned.has(track)) return;
      this._stop(track);
      try { track.close(); } catch (_) { /* A stopped track may already be closed. */ }
      session.owned.delete(track);
    }

    _clearRoot(session) {
      for (const remote of session.remotes.values()) {
        remote.tile?.remove();
        remote.tile = remote.player = remote.label = null;
      }
      this._localPlayer()?.replaceChildren();
      const placeholder = this.root?.querySelector('[data-slot="remotePlaceholder"]');
      if (placeholder) placeholder.hidden = false;
    }

    async _cleanup() {
      const session = this._session;
      if (!session) return;
      this._session = null;
      this.connected = false;
      const errors = [];
      for (const [event, handler] of session.listeners) {
        try {
          if (session.client.off) session.client.off(event, handler);
          else session.client.removeListener(event, handler);
        } catch (error) { errors.push(error); }
      }
      session.unwatch?.();
      for (const track of session.owned) this._close(session, track);
      this.tracks.clear();
      for (const remote of session.remotes.values()) {
        for (const entry of remote.media.values()) if (entry.track) this._stop(entry.track);
        remote.media.clear();
      }
      this._clearRoot(session);
      session.remotes.clear();
      session.pending.clear();
      this.caseId = this.root = this.client = null;
      this.audioBlocked = false;
      try { if (session.client) await session.client.leave(); } catch (error) { errors.push(error); }
      if (errors.length) throw errors[0];
    }
  }

  scope.ReportVideoSession = ReportVideoSession;
  if (typeof module !== 'undefined' && module.exports) module.exports = ReportVideoSession;
})(typeof window !== 'undefined' ? window : globalThis);