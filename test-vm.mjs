import { executeOneInstruction, mulberry32, BeingVM } from './src/sim/vm.js';

const GRID = 256;
const world = {
  planeSize: 20000, STATE_SIZE: 32, GRID, simTime: 0,
  SENSE_COST: 0.2, PLANT_FULL_ENERGY: 130, PLANT_EDIBLE_THRESH: 0.20,
  STRUCTURE_RANGE: 100,
  IRRATIONAL_POOL: [1.6180339887, 2.7182818285, 1.4142135624, 1.7320508076],
  worldhdr: new Uint32Array(8),
  beings:   new Float32Array(4096 * 12),
  food:     new Float32Array(6000 * 6),
  corpse:   new Float32Array(3000 * 5),
  struct:   new Float32Array(6000 * 10),
  patch:    new Float32Array(32 * 8),
  fieldF:   new Float32Array(GRID * GRID),
  fieldD:   new Float32Array(GRID * GRID),
  fieldC:   new Float32Array(GRID * GRID),
  request:  new Float32Array(1024 * 8),
  reqhdr:   new Uint32Array(2),
};

// one food item at (100, 0)
world.food[0] = 100; world.food[1] = 0; world.food[2] = 0.9; world.food[5] = 1;
world.worldhdr[5] = 1;

const rng = mulberry32(777);
const OP = BeingVM.OP;

// eater program: sense food x, +5, sense food z, +3, move, eat, reproduce, loop
const prog = new Uint8Array([
  OP.SENSE_FOOD_X, OP.PUSH, 5, OP.ADD,
  OP.SENSE_FOOD_Z, OP.PUSH, 3, OP.ADD,
  OP.MOVE, OP.EAT, OP.REPRODUCE,
  OP.PUSH, 0, OP.JZ, 0,
]);

const b = {
  id: 1, x: 0, z: 0, energy: 200,
  genes: { sense: 300, speed: 1.0, metabolism: 1.0, repCost: 40, matAge: 10, hue: 0.5, size: 2.0,
           fusionEnabled: 1, fusionSeed: 0.3, fusionDepth: 2, fusionStrength: 0.6,
           fusionAttn: new Float32Array(32).fill(1.0), fusionBias: 0 },
  program: prog, data: new Int8Array(32),
  stack: new Int16Array(32), retStack: new Int16Array(8),
  pc: 0, sp: 0, rsp: 0,
  lastDirX: 1, lastDirZ: 0,
  state: new Float32Array(32), _statePrev: new Float32Array(32),
  symbionts: [],
  _stateMag: 0, _foodCacheTime: -1e9, _foodCache: null, _foodCacheValid: false,
  _neighborCacheTime: -1e9, _neighborCache: null, _neighborCacheValid: false,
  _dangerCacheTime: -1e9, _dangerCache: null, _dangerCacheValid: false,
  _foodNoiseX: 0, _foodNoiseZ: 0, _dangerNoiseX: 0, _dangerNoiseZ: 0,
  _opUse: new Uint16Array(256),
  _lastAction: 0,
  age: 20,
};
world.getBeingById = (id) => (id === b.id ? b : null);

const startEnergy = b.energy;
const startX = b.x;
for (let i = 0; i < 500; i++){
  world.simTime += 0.05;
  for (let j = 0; j < 5; j++){
    if (!executeOneInstruction(b, world, rng)) break;
  }
}

console.log('final x:      ', b.x.toFixed(2), '(was', startX + ')');
console.log('final energy: ', b.energy.toFixed(2), '(was', startEnergy + ')');
console.log('pendingChild: ', b._pendingChild ? 'yes' : 'no');
console.log('food remaining:', world.worldhdr[5]);
console.log('requests made:', world.reqhdr[0]);