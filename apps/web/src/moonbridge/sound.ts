// Moonbridge's sounds, made by the browser itself (Web Audio): no files to download, nothing to
// license. Each cue is a few notes or a puff of filtered noise. A recorded file can replace any of
// them later without touching the scenes: they only call `play("right")`.
//
// The browser lets a page make sound only after the student has tapped it, so nothing plays
// before that, and the student's choice (on / off) is kept on the device.

export type Cue = "tap" | "right" | "typo" | "wrong" | "bell" | "lift" | "whoosh" | "unlock" | "chapter";

const KEY = "moonbridge.sound";

export class Sound {
  private ctx: AudioContext | undefined;
  private ambience: { stop: () => void; kind: string } | undefined;
  private wantedAmbience: "rain" | "hum" | undefined;
  on: boolean;

  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem"> | undefined = safeStorage()) {
    this.on = storage?.getItem(KEY) !== "off";
  }

  toggle(): boolean {
    this.on = !this.on;
    this.storage?.setItem(KEY, this.on ? "on" : "off");
    if (this.on) this.setAmbience(this.wantedAmbience);
    else this.stopAmbience();
    return this.on;
  }

  /** Called on the student's first tap: the browser allows sound from then on. */
  unlock(): void {
    if (!this.on) return;
    const ctx = this.context();
    if (ctx?.state === "suspended") void ctx.resume();
    this.setAmbience(this.wantedAmbience);
  }

  play(cue: Cue): void {
    const ctx = this.on ? this.context() : undefined;
    if (!ctx || ctx.state !== "running") return;
    const t = ctx.currentTime;
    switch (cue) {
      case "tap":
        return this.tone(ctx, t, 880, 0.03, 0.04, "triangle");
      case "right":
        this.tone(ctx, t, 784, 0.12, 0.12);
        return this.tone(ctx, t + 0.09, 1175, 0.22, 0.12);
      case "typo":
        this.tone(ctx, t, 660, 0.1, 0.1);
        return this.tone(ctx, t + 0.1, 622, 0.16, 0.08);
      case "wrong":
        return this.tone(ctx, t, 196, 0.22, 0.14, "triangle", 150);
      case "bell":
        this.tone(ctx, t, 1568, 0.6, 0.1);
        return this.tone(ctx, t, 2093, 0.4, 0.05);
      case "lift":
        this.noise(ctx, t, 0.7, 300, 0.05);
        return this.tone(ctx, t + 0.75, 1046, 0.7, 0.12);
      case "whoosh":
        return this.noise(ctx, t, 0.45, 1200, 0.06);
      case "unlock":
        [523, 659, 784, 1046].forEach((f, i) => this.tone(ctx, t + i * 0.09, f, 0.3, 0.1));
        return;
      case "chapter":
        this.tone(ctx, t, 392, 0.9, 0.06);
        this.tone(ctx, t, 587, 0.9, 0.05);
        return this.tone(ctx, t + 0.25, 784, 0.8, 0.05);
    }
  }

  /** A quiet loop under the scene: rain at night, the hum of the hotel by day. */
  setAmbience(kind: "rain" | "hum" | undefined): void {
    this.wantedAmbience = kind;
    if (this.ambience?.kind === kind) return;
    this.stopAmbience();
    const ctx = this.on && kind ? this.context() : undefined;
    if (!ctx || ctx.state !== "running" || !kind) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 2);
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = kind === "rain" ? "highpass" : "lowpass";
    filter.frequency.value = kind === "rain" ? 1800 : 220;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(kind === "rain" ? 0.035 : 0.05, ctx.currentTime + 1.5);
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start();
    this.ambience = {
      kind,
      stop: () => {
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.4);
        src.stop(ctx.currentTime + 0.45);
      },
    };
  }

  stopAmbience(): void {
    this.ambience?.stop();
    this.ambience = undefined;
  }

  private context(): AudioContext | undefined {
    if (this.ctx) return this.ctx;
    const Ctor = globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return undefined;
    try {
      this.ctx = new Ctor();
    } catch {
      return undefined;
    }
    return this.ctx;
  }

  private tone(ctx: AudioContext, at: number, freq: number, length: number, volume: number, type: OscillatorType = "sine", slideTo?: number): void {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, at + length);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(volume, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + length + 0.02);
  }

  private noise(ctx: AudioContext, at: number, length: number, freq: number, volume: number): void {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, length);
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(freq, at);
    filter.frequency.exponentialRampToValueAtTime(freq * 3, at + length);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(volume, at + length / 3);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start(at);
  }
}

function noiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
