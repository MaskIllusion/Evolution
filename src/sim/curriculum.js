export const CURRICULA = {
  'default-v1': [
    { name: 'food-only',  food: true, danger: false, predator: false, signal: false, delay: false, ticks: 500  },
    { name: 'danger',     food: true, danger: true,  predator: false, signal: false, delay: false, ticks: 1500 },
    { name: 'predation',  food: true, danger: true,  predator: true,  signal: false, delay: false, ticks: 3000 },
    { name: 'social',     food: true, danger: true,  predator: true,  signal: true,  delay: false, ticks: 5000 },
    { name: 'credit',     food: true, danger: true,  predator: true,  signal: true,  delay: true,  ticks: 20000 },
  ],
  'no-predation': [
    { name: 'food-only', food: true, danger: true, predator: false, signal: false, delay: false, ticks: 5000 },
    { name: 'social',    food: true, danger: true, predator: false, signal: true,  delay: true,  ticks: 25000 },
  ],
  'delay-first': [
    { name: 'delay-cold', food: true, danger: true, predator: false, signal: false, delay: true, ticks: 8000 },
    { name: 'delay-warm', food: true, danger: true, predator: true,  signal: true,  delay: true, ticks: 20000 },
  ],
};