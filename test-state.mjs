import { updateState, updatePlasticity, mulberry32 } from './src/sim/vm.js';

const GRID = 256;
const world = {
  planeSize: 20000,
  STATE_SIZE: 32,
  IRRATIONAL_POOL: [1.6180339887, 2.7182818285, 1.4142135624, 1.7320508076,
                    2.2360679775, 2.6457513111, 2.8284271247, 3.3166247904],
  SENSE_COST: 0.2,
  GRID,
  simTime: 0,
  worldhdr: new Uint32Array(8),
  beings:  new Float32Array(4096 * 12),
  food:    new Float32Array(6000 * 6),
  corpse:  new Float32Array(3000 * 5),
  struct:  new Float32Array(6000 * 10),
  patch:   new Float32Array(32 * 8),
  fieldF:  new Float32Array(GRID * GRID),
  fieldD:  new Float32Array(GRID * GRID),
  fieldC:  new Float32Array(GRID * GRID),
};

const rng = mulberry32(12345);

const b = {
  x: 0, z: 0, energy: 150,
  genes: {
    fusionEnabled: 1, fusionSeed: 0.37, fusionDepth: 2, fusionStrength: 0.6,
    fusionAttn: new Float32Array(32).fill(1.0), fusionBias: 0,
    stateDecay: 0.4, stateCoupling: 0.5, stateInput: 1.0,
    statePlasticity: 1.0,
    plasticityRule: new Float32Array([1,1,1]),
  },
  state:       new Float32Array(32),
  _statePrev:  new Float32Array(32),
  _effDecay:   0.4, _effCoupling: 0.5, _effInput: 1.0,
  _effDecayWorking: 0.01, _effDecayIdentity: 0.0005,
  _corrSum:    new Float32Array(32),
  _varS:       new Float32Array(32),
  _varF: 0, _corrWindow: 0, _rhoEMA: 0.5, _fusedPrev: 0, _fusionValid: false,
  _kappaEMA: 0.3, _stateAge: 0, _prevEnergy: 150, _stateMag: 0,
  _valence: 0, _selfTrace: 0, _selfTraceVar: 0, _selfTraceAge: 0,
  _otherFused: 0, _g2: 0, _g2Ready: false, _g2Use: 0,
  _predWeights: new Float32Array(32),
  _predBias: 0, _predictedFused: 0, _predError: 0,
  _worldModel: { W: new Float32Array(32*32), bias: 0, predictedFused: 0, predictionError: 0 },
  _opUse: new Uint16Array(256),
  _arousalRef: 150,
  _socialCache: 0, _socialCacheTime: 0,
  lastDirX: 0, lastDirZ: 1,
  _lastAction: 0,
};

for (let i = 0; i < 200; i++){
  world.simTime += 0.05;
  updateState(b, world, rng, 0.05);
  if (i % 40 === 39) updatePlasticity(b, 2.0);
}

let sum = 0;
for (let i = 0; i < 32; i++) sum += b.state[i];

console.log('state sum:    ', sum.toFixed(3));
console.log('fusedSelf:    ', b._fusedSelf.toFixed(4));
console.log('valence:      ', b._valence.toFixed(4));
console.log('stateMag:     ', b._stateMag.toFixed(3));
console.log('selfTrace:    ', b._selfTrace.toFixed(4));
console.log('rhoEMA:       ', b._rhoEMA.toFixed(4));
console.log('effCoupling:  ', b._effCoupling.toFixed(4));
console.log('worldErr:     ', b._worldModel.predictionError.toFixed(4));