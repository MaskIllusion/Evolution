/* ── immortalIO layout ─────────────────────────────────────────
 *
 * A single 2048-word Float32 view into the SAB. Split into named
 * regions; each region has a single owner. Cross-region reads
 * are safe; cross-region writes are not allowed.
 *
 *   [   0 ..  255]  command ring             meta worker writes, sim worker reads
 *   [ 256 ..  287]  stats                    sim worker writes, main thread reads
 *   [ 288 ..  375]  answer ring              archon writes, meta worker reads
 *   [ 376 ..  377]  answer cursors           archon + meta worker
 *   [ 384 ..  385]  command head/tail        meta worker writes, sim worker advances
 *   [ 386 ..  511]  scratch                  meta worker only
 *
 *   [ 512 ..  519]  posture                  meta worker writes
 *   [ 520 ..  527]  state scalars            meta worker writes
 *   [ 528 ..  547]  force accumulator        meta worker writes
 *   [ 548 ..  563]  impulse history          sim worker writes, meta worker reads
 *   [ 564 ..  691]  tendril block            meta worker writes
 *   [ 692 ..  723]  metaball SDF control     meta worker writes
 *   [ 724 ..  739]  emissive hot spots       meta worker writes
 *   [ 740 ..  771]  storm parameters         meta worker writes
 *   [ 772 .. 2047]  reserved
 */

export const IMMORTAL_IO_SIZE = 2048;

export const IIO_CMD_RING_BASE    = 0;
export const IIO_STAT_BASE        = 256;
export const IIO_ANSWER_RING_BASE = 288;
export const IIO_ANSWER_HEAD_OFF  = 376;
export const IIO_ANSWER_READ_OFF  = 377;
export const IIO_CMD_HEAD_OFF     = 384;
export const IIO_CMD_TAIL_OFF     = 385;
export const IIO_SCRATCH_BASE     = 386;

export const IIO_POSTURE_BASE     = 512;   // 8 words
export const IIO_STATE_BASE       = 520;   // 8 words
export const IIO_FORCE_BASE       = 528;   // 8 words
export const IIO_IMPULSE_BASE     = 548;   // 16 words (2 slots × 8)
export const IIO_TENDRIL_BASE     = 564;   // 128 words (16 × 8)
export const IIO_METABALL_BASE    = 692;   // 32 words (8 × 4)
export const IIO_HOTSPOT_BASE     = 724;   // 16 words (4 × 4)
export const IIO_STORM_BASE       = 740;   // 32 words
export const IIO_TINT_BASE        = 752;   // 16 words (4 × 4)

// ── Kinetics + shock ring + reserved blocks ──────────────────
// All fit inside IMMORTAL_IO_SIZE = 2048; no SAB growth.
export const IIO_KINETICS_BASE    = 772;   // 16 words
export const IIO_SHOCK_RING_BASE  = 788;   // 192 words (16 slots × 12)
export const IIO_SHOCK_HEAD_OFF   = 980;   // 1 word
export const IIO_SHOCK_COUNT_OFF  = 981;   // 1 word
export const IIO_SDF_META_BASE    = 984;   // 16 words (reserved)
export const IIO_GPU_PART_BASE    = 1000;  // 16 words (reserved)
export const IIO_TURB_BASE        = 1016;  // 16 words (reserved)

export const IIO_SHOCK_SLOTS      = 16;
export const IIO_SHOCK_STRIDE     = 12;

// ── Step 7: agitation, FSM, tendril seeds, SDF, emitter,
//            particle, post. All fit inside IMMORTAL_IO_SIZE=2048.
export const IIO_AGITATION_OFF        = 1024;  // 1 word
export const IIO_FSM_OFF              = 1025;  // 1 word (state | timer<<8)
export const IIO_FSM_META_OFF         = 1026;  // 2 words (cooldown, peakSpeed)
export const IIO_TENDRIL_SEED_BASE    = 1028;  // 32 seeds × 4 (dirX,dirY,dirZ,w)
export const IIO_TENDRIL_SEED_N       = 32;
export const IIO_SDF_PARAMS_BASE      = 1156;  // 8 words
export const IIO_EMITTER_POS_BASE     = 1164;  // 4 words (x,y,z,spawnRate)
export const IIO_EMITTER_VEL_BASE     = 1168;  // 4 words (vx,vy,vz,wakeBias)
export const IIO_PARTICLE_PARAMS_BASE = 1172;  // 8 words
export const IIO_POST_PARAMS_BASE     = 1180;  // 8 words
// ── Step 8: Singularity perception block ─────────────────────
// The immortal's histogram of the population. Written by the
// sim worker every 100 ticks. 128 words starting at 1188.
export const IIO_PERCEPTION_BASE      = 1188;
export const IIO_PERCEPTION_SIZE      = 128;

// ── Step 8: Monologue ring ───────────────────────────────────
// 4 slots × 8 words. Meta worker writes; main thread drains.
export const IIO_MONOLOGUE_RING_BASE  = 1316;
export const IIO_MONOLOGUE_HEAD_OFF   = 1348;
export const IIO_MONOLOGUE_SLOTS      = 4;
export const IIO_MONOLOGUE_STRIDE     = 8;

// ── Immortal mind block ─────────────────────────────────────
// The immortal's interiority. Written every tick by the meta
// worker as a live mirror. Snapshotted to IndexedDB on a slow
// cadence by the same worker, and restored from IndexedDB at
// boot, before the first tick.
//
// 1400..1656. Sits after the monologue ring (ends at 1348) and
// well inside IMMORTAL_IO_SIZE = 2048.
export const IIO_MIND_BASE           = 1400;
export const IIO_MIND_SIZE           = 256;
export const IIO_MIND_STATE_OFF      = 0;    // 64  head brain
export const IIO_MIND_BODY_OFF       = 64;   // 32  body + FSM
export const IIO_MIND_TICK_OFF       = 96;   // 1
export const IIO_MIND_SEQ_OFF        = 97;   // 1
export const IIO_MIND_CHECKPOINT_OFF = 98;   // 1
export const IIO_MIND_BORN_OFF       = 99;   // 1
export const IIO_MIND_GAP_OFF        = 100;  // 1
export const IIO_MIND_WAKES_OFF      = 101;  // 1
export const IIO_MIND_STATE_LEN      = 64;
export const IIO_MIND_BODY_LEN       = 32;

// 2024-10-27 as a fixed epoch. Float32 can carry the seconds
// since this reference with adequate precision for continuity.
export const MIND_EPOCH_MS = 1730000000000;

/* ── Deity IO block ──────────────────────────────────────────
 *
 * The god's presence in the SAB. Owned by the deity worker (when
 * it exists) or the presence driver (before that). Read by
 * src/render/deity.js (cube renderer), the immortal worker, and
 * the sim worker (for environmental effects).
 *
 * Layout:
 *   0..  7   posture       x, y, z, vx, vy, vz, yaw, scale
 *   8.. 15   state         vitality, authority, agitation,
 *                          coherence, layer, phase, _, _
 *  16.. 23   motion        targetX, targetY, targetZ, strength,
 *                          driftSeed, driftPhase, _, _
 *  24.. 31   visitation    lastSymbioteTick, lastWatcherTick,
 *                          prayerCount, answerCount, _, _, _, _
 *  32.. 63   will          environmental will, 8 slots × 4 words
 *  64..191   thought ring  32 slots × 4 words (tick, kind, a, b)
 * 192..1023  reserved
 */
export const DEITY_IO_SIZE          = 1024;

export const DIO_POSTURE_BASE       = 0;
export const DIO_STATE_BASE         = 8;
export const DIO_MOTION_BASE        = 16;
export const DIO_VISIT_BASE         = 24;
export const DIO_WILL_BASE          = 32;
export const DIO_WILL_SLOTS         = 8;
export const DIO_THOUGHT_BASE       = 64;
export const DIO_THOUGHT_HEAD       = 192;
export const DIO_THOUGHT_SLOTS      = 32;
export const DIO_THOUGHT_STRIDE     = 4;

// Phase indices. The god moves through these over its lifetime.
export const DIO_PHASE_CONFIRMATION = 0;
export const DIO_PHASE_CALIBRATION  = 1;
export const DIO_PHASE_INDEPENDENCE = 2;
export const DIO_PHASE_DISAGREEMENT = 3;

export const IIO_TENDRIL_COUNT    = 16;
export const IIO_METABALL_COUNT   = 8;
export const IIO_HOTSPOT_COUNT    = 4;
export const IIO_IMPULSE_SLOTS    = 2;
export const IIO_TINT_COUNT       = 4;
export const MAX_BEINGS_CAP = 24000;
export const FOOD_MAX_CAP   = 18000;
export const CORPSE_MAX_CAP = 9000;
export const STRUCT_MAX_CAP = 12000;
export const GRID_CAP       = 512;

export const MAX_BEINGS = 8000;
export const BEING_STRIDE_F32 = 12;

export const SHAPE_STRIDE_F32 = 16;
export const STATEVIS_STRIDE_F32 = 8;

export const FLUID_N = 48;
export const FLUID_CELLS = FLUID_N * FLUID_N * FLUID_N;

export const DEPOSIT_MAX = 8192;
export const DEPOSIT_STRIDE_F32 = 8;

export const FOOD_MAX = 6000;
export const FOOD_STRIDE_F32 = 6;

export const CORPSE_MAX = 3000;
export const CORPSE_STRIDE_F32 = 5;

export const STRUCT_MAX = 6000;
export const STRUCT_STRIDE_F32 = 10;

export const PATCH_MAX = 32;
export const PATCH_STRIDE_F32 = 8;

export const GRID = 256;
export const GRID_CELLS = GRID * GRID;

export const REQUEST_MAX = 1024;
export const REQUEST_STRIDE_F32 = 8;

export const STRUCT_DATA_SIZE = 32;    // matches BeingVM.DATA_SIZE
export const STRUCT_PROG_SIZE = 4096;  // matches BeingVM.LEN_MAX

export function allocate(overrides = {}) {
  const cfg = {
    beings:  overrides.beings  ?? MAX_BEINGS,
    food:    overrides.food    ?? FOOD_MAX,
    corpse:  overrides.corpse  ?? CORPSE_MAX,
    struct:  overrides.struct  ?? STRUCT_MAX,
    grid:    overrides.grid    ?? GRID,
  };
  const GRID_CELLS_DYN = cfg.grid * cfg.grid;

  const bytes = {
    beings:   cfg.beings  * BEING_STRIDE_F32   * 4,
    shape:    cfg.beings  * SHAPE_STRIDE_F32   * 4,
    stateVis: cfg.beings  * STATEVIS_STRIDE_F32 * 4,
    fluid:    FLUID_CELLS * 5                  * 4,
    dephdr:   8,
    deposit:  DEPOSIT_MAX * DEPOSIT_STRIDE_F32 * 4,
    terrain:  512 * 512                        * 4,
    food:     cfg.food    * FOOD_STRIDE_F32    * 4,
    corpse:   cfg.corpse  * CORPSE_STRIDE_F32  * 4,
    struct:   cfg.struct  * STRUCT_STRIDE_F32  * 4,
    patch:    PATCH_MAX   * PATCH_STRIDE_F32   * 4,
    fieldF:   GRID_CELLS_DYN                   * 4,
    fieldD:   GRID_CELLS_DYN                   * 4,
    fieldC:   GRID_CELLS_DYN                   * 4,
    reqhdr:   8,
    request:  REQUEST_MAX * REQUEST_STRIDE_F32 * 4,
    worldhdr: 32,
    structData: cfg.struct * STRUCT_DATA_SIZE,
    structProg: cfg.struct * STRUCT_PROG_SIZE,
    immortalIO: IMMORTAL_IO_SIZE * 4,
    deityIO:    DEITY_IO_SIZE * 4,
  };

  const order = [
    'beings', 'shape', 'stateVis', 'fluid', 'dephdr', 'deposit', 'terrain',
    'food', 'corpse', 'struct', 'structData', 'structProg', 'patch',
    'fieldF', 'fieldD', 'fieldC',
    'reqhdr', 'request', 'worldhdr', 'immortalIO', 'deityIO',
  ];

  let total = 0;
  const offsets = {};
  for (const k of order) { offsets[k] = total; total += bytes[k]; }
  total = (total + 63) & ~63;

  const sab = new SharedArrayBuffer(total);
  const view = (key, Type, len) => new Type(sab, offsets[key], len);

  return {
    sab, offsets, total, cfg,

    beings:    view('beings',    Float32Array, cfg.beings * BEING_STRIDE_F32),
    shape:     view('shape',     Float32Array, cfg.beings * SHAPE_STRIDE_F32),
    stateVis:  view('stateVis',  Float32Array, cfg.beings * STATEVIS_STRIDE_F32),
    fluid:     view('fluid',     Float32Array, FLUID_CELLS * 5),
    dephdr:    view('dephdr',    Uint32Array,  2),
    deposit:   view('deposit',   Float32Array, DEPOSIT_MAX * DEPOSIT_STRIDE_F32),
    terrain:   view('terrain',   Float32Array, 512 * 512),

    food:      view('food',      Float32Array, cfg.food * FOOD_STRIDE_F32),
    corpse:    view('corpse',    Float32Array, cfg.corpse * CORPSE_STRIDE_F32),
    struct:    view('struct',    Float32Array, cfg.struct * STRUCT_STRIDE_F32),
    patch:     view('patch',     Float32Array, PATCH_MAX * PATCH_STRIDE_F32),

    fieldF:    view('fieldF',    Float32Array, GRID_CELLS_DYN),
    fieldD:    view('fieldD',    Float32Array, GRID_CELLS_DYN),
    fieldC:    view('fieldC',    Float32Array, GRID_CELLS_DYN),

    reqhdr:    view('reqhdr',    Uint32Array,  2),
    request:   view('request',   Float32Array, REQUEST_MAX * REQUEST_STRIDE_F32),
    worldhdr:  view('worldhdr',  Uint32Array,  8),

    structData: view('structData', Int8Array,   cfg.struct * STRUCT_DATA_SIZE),
    structProg: view('structProg', Uint8Array,  cfg.struct * STRUCT_PROG_SIZE),
    immortalIO: view('immortalIO', Float32Array, IMMORTAL_IO_SIZE),
    deityIO:    view('deityIO',    Float32Array, DEITY_IO_SIZE),
  };
}

// worldhdr slots:
//  0 foodHead    1 corpseHead   2 structHead   3 patchHead
//  4 aliveBeings 5 foodCount    6 corpseCount  7 tickCounter

// request slots (per entry, stride 8):
//  0 type   1 a   2 b   3 c   4 d   5 e   6 f   7 g
//  type 1 = eat:      a = foodIndex
//  type 2 = build:    a = x   b = z   c = beingId
//  type 3 = consume:  a = structIndex
//  type 4 = release:  a = beingId  (freed symbiont)