// Small Web Audio wrapper. Sounds are the same ones used by the Android app (re-encoded to mp3).
const SFX = ['click', 'home', 'spawn', 'token', 'kill', 'dice'];

export class AudioManager {
  constructor(base = 'assets/audio/') {
    this.base = base;
    this.ctx = null;
    this.buffers = {};
    this.loading = null;
    this.sfxEnabled = true;
    this.musicEnabled = localStorage.getItem('ludo.music.v2') !== 'off'; // ON unless the player switched it off
    this.music = new Audio(base + 'background.mp3');
    this.music.loop = true;
    this.music.volume = 0.5;
    this.music.preload = 'none';
    this.musicWanted = false; // whether the current screen wants music
  }

  /** Must be called from a user gesture (browser autoplay policy). */
  unlock() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      if (!this.loading) this.loading = this._loadAll();
    } catch (e) { /* audio is optional */ }
    this._syncMusic();
  }

  async _loadAll() {
    await Promise.all(SFX.map(async (name) => {
      try {
        const res = await fetch(`${this.base}${name}.mp3`);
        const data = await res.arrayBuffer();
        this.buffers[name] = await this.ctx.decodeAudioData(data);
      } catch (e) { /* ignore missing/failed sound */ }
    }));
  }

  play(name, volume = 1) {
    if (!this.sfxEnabled || !this.ctx || !this.buffers[name]) return;
    try {
      const src = this.ctx.createBufferSource();
      const gain = this.ctx.createGain();
      gain.gain.value = volume;
      src.buffer = this.buffers[name];
      src.connect(gain).connect(this.ctx.destination);
      src.start(0);
    } catch (e) { /* ignore */ }
  }

  click() { this.play('click'); }
  home() { this.play('home'); }
  spawn() { this.play('spawn'); }
  token() { this.play('token', 0.8); }
  kill() { this.play('kill'); }
  dice() { this.play('dice'); }

  setMusicEnabled(on) {
    this.musicEnabled = on;
    localStorage.setItem('ludo.music.v2', on ? 'on' : 'off');
    this._syncMusic();
  }

  /** Screens call this: music plays on dashboard/lobby, stops in game (same as the Android app). */
  wantMusic(wanted) {
    this.musicWanted = wanted;
    this._syncMusic();
  }

  _syncMusic() {
    if (this.musicEnabled && this.musicWanted) {
      this.music.preload = 'auto';
      const p = this.music.play(); // may be rejected until the first user gesture; unlock() retries
      if (p && p.catch) p.catch(() => {});
    } else {
      this.music.pause();
    }
  }

  isMusicPlaying() { return !this.music.paused; }
}
