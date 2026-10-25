import { average } from "./utils/mathUtil";
import VISEMES from "./visemes";

// Based on Oculus LipSync viseme set
// https://developers.meta.com/horizon/documentation/unity/audio-ovrlipsync-viseme-reference/

enum FSMStates {
  silence = "silence",
  vowel = "vowel",
  plosive = "plosive",
  fricative = "fricative",
}

const VISEMES_STATES: { [key in VISEMES]: FSMStates } = {
  [VISEMES.sil]: FSMStates.silence,
  [VISEMES.PP]: FSMStates.plosive,
  [VISEMES.FF]: FSMStates.fricative,
  [VISEMES.TH]: FSMStates.fricative,
  [VISEMES.DD]: FSMStates.plosive,
  [VISEMES.kk]: FSMStates.plosive,
  [VISEMES.CH]: FSMStates.fricative,
  [VISEMES.SS]: FSMStates.fricative,
  [VISEMES.nn]: FSMStates.plosive,
  [VISEMES.RR]: FSMStates.fricative,
  [VISEMES.aa]: FSMStates.vowel,
  [VISEMES.E]: FSMStates.vowel,
  [VISEMES.I]: FSMStates.vowel,
  [VISEMES.O]: FSMStates.vowel,
  [VISEMES.U]: FSMStates.vowel,
};

interface Feature {
  bands: number[];
  deltaBands: number[];
  volume: number;
  centroid: number;
}

interface Band {
  start: number;
  end: number;
}

export class Lipsync {
  public features: Feature | null = null;
  public viseme: VISEMES = VISEMES.sil;
  // Created lazily on first use so the class can be constructed during
  // server-side rendering (e.g. Next.js), where `window` is not defined.
  private audioContext?: AudioContext;
  private analyser?: AnalyserNode;
  private dataArray: Uint8Array = new Uint8Array(0);
  private fftSize: number;
  private history: Feature[];
  private historySize: number;
  private sampleRate: number = 0;
  private binWidth: number = 0;
  private bands: Band[];
  private audioSource?: HTMLMediaElement;
  private state: FSMStates = FSMStates.silence;
  private visemeStartTime: number = 0; // Timestamp when current viseme started (ms)
  private maxVisemeDuration: number = 100; // Max duration in ms before penalty kicks in
  constructor(
    params = {
      fftSize: 2048,
      historySize: 10,
    }
  ) {
    const { fftSize = 2048, historySize = 10 } = params;
    this.fftSize = fftSize;
    this.history = [];
    this.historySize = historySize;

    // Define frequency bands (in Hz)
    this.bands = [
      { start: 50, end: 200 }, // Band 1: Low energy
      { start: 200, end: 400 }, // Band 2: F1 lower
      { start: 400, end: 800 }, // Band 3: F1 mid
      { start: 800, end: 1500 }, // Band 4: F2 front
      { start: 1500, end: 2500 }, // Band 5: F2/F3
      { start: 2500, end: 4000 }, // Band 6: Fricatives
      { start: 4000, end: 8000 }, // Band 7: High fricatives
    ];
  }

  private ensureAudioContext(): {
    audioContext: AudioContext;
    analyser: AnalyserNode;
  } {
    if (!this.audioContext || !this.analyser) {
      if (typeof window === "undefined") {
        throw new Error(
          "wawa-lipsync: Web Audio is only available in the browser"
        );
      }
      this.audioContext = new (window.AudioContext ||
        (window as any).webkitAudioContext)();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = this.fftSize;
      this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      this.sampleRate = this.audioContext.sampleRate;
      this.binWidth = this.sampleRate / this.fftSize;
    }
    return { audioContext: this.audioContext, analyser: this.analyser };
  }

  connectAudio(audio: HTMLMediaElement) {
    const { audioContext, analyser } = this.ensureAudioContext();
    audioContext.resume();
    this.history = [];
    this.features = null;
    this.state = FSMStates.silence;
    this.visemeStartTime = performance.now();

    if (this.audioSource === audio) {
      return;
    }
    this.audioSource = audio;
    if (!audio.src) {
      console.warn("An audio source must be set before connecting");
      return;
    }
    const source = audioContext.createMediaElementSource(audio);
    source.connect(analyser);
    analyser.connect(audioContext.destination);
  }

  // Connect live microphone
  async connectMicrophone() {
    const { audioContext, analyser } = this.ensureAudioContext();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      analyser.connect(audioContext.destination);
      return source;
    } catch (err) {
      console.error("Error accessing microphone:", err);
      throw err;
    }
  }

  extractFeatures() {
    const { analyser } = this.ensureAudioContext();
    analyser.getByteFrequencyData(this.dataArray);

    // Convert frequency ranges to bin indices
    const bandEnergies = this.bands.map(({ start, end }) => {
      const startBin = Math.round(start / this.binWidth);
      const endBin = Math.min(
        Math.round(end / this.binWidth),
        this.dataArray.length - 1
      );
      return average(Array.from(this.dataArray.slice(startBin, endBin))) / 255;
    });

    // Compute spectral centroid
    let sumAmplitude = 0;
    let weightedSum = 0;
    for (let i = 0; i < this.dataArray.length; i++) {
      const freq = i * this.binWidth;
      const amp = this.dataArray[i] / 255;
      sumAmplitude += amp;
      weightedSum += freq * amp;
    }
    const centroid = sumAmplitude > 0 ? weightedSum / sumAmplitude : 0;

    // Compute volume
    const volume = average(bandEnergies);

    const deltaBands = bandEnergies.map((energy, index) => {
      if (this.history.length < 2) return 0;
      const previousEnergy = this.history[this.history.length - 2].bands[index];
      return energy - previousEnergy;
    });

    const features = {
      bands: bandEnergies,
      deltaBands: deltaBands,
      volume,
      centroid,
    };

    // Update history
    if (sumAmplitude > 0) {
      // Only add to history if there's sound
      this.history.push(features);
      if (this.history.length > this.historySize) {
        this.history.shift();
      }
    }

    return features;
  }

  getAveragedFeatures(): Feature {
    const len = this.history.length;
    const sum = {
      volume: 0,
      centroid: 0,
      bands: Array(this.bands.length).fill(0),
    };

    for (const f of this.history) {
      sum.volume += f.volume;
      sum.centroid += f.centroid;
      f.bands.forEach((b, i) => (sum.bands[i] += b));
    }

    const bands = sum.bands.map((b) => b / len);
    return {
      volume: sum.volume / len,
      centroid: sum.centroid / len,
      bands,
      deltaBands: bands,
    };
  }

  detectState() {
    const current = this.history[this.history.length - 1];
    if (!current) {
      this.state = FSMStates.silence;
      this.viseme = VISEMES.sil;
      return;
    }

    const avg = this.getAveragedFeatures();
    const dVolume = current.volume - avg.volume;
    const dCentroid = current.centroid - avg.centroid;

    // Scoring function for visemes
    const visemeScores = this.computeVisemeScores(
      current,
      avg,
      dVolume,
      dCentroid
    );

    // Adjust scores for consistency based on current state and viseme
    const adjustedScores = this.adjustScoresForConsistency(visemeScores);

    // Select the highest-scoring viseme
    let maxScore = -Infinity;
    let topViseme: VISEMES = VISEMES.sil;
    for (const viseme in adjustedScores) {
      if (adjustedScores[viseme as VISEMES] > maxScore) {
        maxScore = adjustedScores[viseme as VISEMES];
        topViseme = viseme as VISEMES;
      }
    }

    // Map viseme to state
    let newState = VISEMES_STATES[topViseme];

    // Track viseme duration - reset timestamp if viseme changed
    if (topViseme !== this.viseme) {
      this.visemeStartTime = performance.now();
    }

    // Update state and viseme
    this.state = newState;
    this.viseme = topViseme;

    // Debugging: Log scores and features
    // if (this.history.length === this.historySize) {
    //   console.table([
    //     ...this.history.map((f) => ({
    //       volume: f.volume,
    //       centroid: f.centroid,
    //       state: this.state,
    //       viseme: this.viseme,
    //     })),
    //   ]);
    //   console.log(`Scores: ${JSON.stringify(adjustedScores, null, 2)}`);
    // }
  }

  // Compute scores for each viseme
  computeVisemeScores(
    current: Feature,
    avg: Feature,
    dVolume: number,
    dCentroid: number
  ) {
    const scores: { [key in VISEMES]: number } = {
      [VISEMES.sil]: 0,
      [VISEMES.PP]: 0,
      [VISEMES.FF]: 0,
      [VISEMES.TH]: 0,
      [VISEMES.DD]: 0,
      [VISEMES.kk]: 0,
      [VISEMES.CH]: 0,
      [VISEMES.SS]: 0,
      [VISEMES.nn]: 0,
      [VISEMES.RR]: 0,
      [VISEMES.aa]: 0,
      [VISEMES.E]: 0,
      [VISEMES.I]: 0,
      [VISEMES.O]: 0,
      [VISEMES.U]: 0,
    };

    const [_b1, _b2, _b3, _b4, _b5, _b6, b7] = current.bands;

    // Silence
    if (avg.volume < 0.2 && current.volume < 0.2) {
      scores[VISEMES.sil] = 1.0;
    }

    // Plosives: High delta, broad centroid range
    Object.entries(VISEMES_STATES).forEach(([viseme, state]) => {
      if (state === FSMStates.plosive) {
        if (dVolume < 0.01) {
          scores[viseme as VISEMES] -= 0.5; // Possibly a fade-out
        }
        if (avg.volume < 0.2) {
          scores[viseme as VISEMES] += 0.2;
        }
        if (dCentroid > 1000) {
          scores[viseme as VISEMES] += 0.2;
        }
      }
    });

    if (current.centroid > 1000 && current.centroid < 8000) {
      // Burst after low energy
      if (current.centroid > 7000) {
        scores[VISEMES.DD] += 0.6;
      } else if (current.centroid > 5000) {
        scores[VISEMES.kk] += 0.6;
      } else if (current.centroid > 4000) {
        scores[VISEMES.PP] += 1;
        if (b7 > 0.25 && current.centroid < 6000) {
          scores[VISEMES.DD] += 1.4;
        }
      } else {
        scores[VISEMES.nn] += 0.6;
      }
    }

    // Fricatives: High-frequency energy, high centroid
    if (dCentroid > 1000 && current.centroid > 6000 && avg.centroid > 5000) {
      if (current.bands[6] > 0.4 && avg.bands[6] > 0.3) {
        scores[VISEMES.FF] = 0.7;
      }
    }

    // Vowels: Sustained mid-frequency energy, moderate centroid
    if (avg.volume > 0.1 && avg.centroid < 6000 && current.centroid < 6000) {
      const [b1, b2, b3, b4, b5] = avg.bands;
      const gapB1B2 = Math.abs(b1 - b2);
      const maxGapB2B3B4 = Math.max(
        Math.abs(b2 - b3),
        Math.abs(b2 - b4),
        Math.abs(b3 - b4)
      );

      if (b3 > 0.1 || b4 > 0.1) {
        if (b4 > b3) {
          scores[VISEMES.aa] = 0.8;
          if (b3 > b2) {
            scores[VISEMES.aa] += 0.2;
          }
        }
        if (b3 > b2 && b3 > b4) {
          scores[VISEMES.I] = 0.7;
        }
        if (gapB1B2 < 0.25) {
          scores[VISEMES.U] = 0.7;
        }
        if (maxGapB2B3B4 < 0.25) {
          scores[VISEMES.O] = 0.9;
        }
        if (b2 > b3 && b3 > b4) {
          scores[VISEMES.E] = 1;
        }
        // if (b3 > 0.2 && b4 > 0.2) {
        //   scores[VISEMES.E] += 0.8;
        // }
        if (b3 < 0.2 && b4 > 0.3) {
          scores[VISEMES.I] = 0.7;
        }
        if (b3 > 0.25 && b5 > 0.25) {
          scores[VISEMES.O] = 0.7;
        }
        if (b3 < 0.15 && b5 < 0.15) {
          scores[VISEMES.U] = 0.7;
        }
      }
    }

    return scores;
  }

  // Adjust scores based on current state and viseme for consistency
  adjustScoresForConsistency(scores: Record<VISEMES, number>) {
    const adjustedScores = { ...scores };

    // Apply decaying boost/penalty based on viseme duration
    if (this.viseme && this.state) {
      const currentTime = performance.now();
      const visemeDuration = currentTime - this.visemeStartTime; // Duration in ms

      for (const viseme in adjustedScores) {
        const isCurrentViseme = viseme === this.viseme;

        if (isCurrentViseme) {
          // Calculate decay factor based on duration
          // Early phase (0-100ms): Full boost (1.3x)
          // Mid phase (100-300ms): Gradual decay from 1.3x to 1.0x
          // Late phase (300ms+): Penalty that increases over time
          let boostFactor: number;

          const earlyPhaseEnd = 100; // ms

          if (visemeDuration <= earlyPhaseEnd) {
            // Normal boost for first 100ms
            boostFactor = 1.3;
          } else if (visemeDuration <= this.maxVisemeDuration) {
            // Gradual decay: linearly interpolate from 1.3 to 1.0
            const decayRange = this.maxVisemeDuration - earlyPhaseEnd;
            const decay = (visemeDuration - earlyPhaseEnd) / decayRange;
            boostFactor = 1.3 - 0.3 * decay;
          } else {
            // Apply penalty after maxVisemeDuration
            // Penalty increases the longer it's held
            const excessDuration = visemeDuration - this.maxVisemeDuration;
            boostFactor = Math.max(0.5, 1.0 - excessDuration / 1000);
          }

          adjustedScores[viseme] *= boostFactor;
        }
      }
    }

    return adjustedScores;
  }

  processAudio() {
    this.features = this.extractFeatures();
    this.detectState();
  }
}

export default Lipsync;
