import * as Q from './queries.js';
import { STRUCT_DATA_SIZE, STRUCT_PROG_SIZE } from './shared-buffer.js';
/* ══════════════════════════════════════════════════════════════════════
 *  THE BEING VM
 *
 *  A tiny virtual machine. Each being carries a program of up to 64
 *  bytes. One byte is one instruction (some instructions take one
 *  operand byte). A 16-slot signed stack holds intermediate values.
 *  A program counter steps through the bytes.
 *
 *  Nothing about a being's behaviour is scripted. What you see on the
 *  plane is what the surviving programs happen to do. Behaviours that
 *  eat and reproduce spread. Behaviours that starve die.
 *
 *  The instruction set is intentionally minimal. Each new sense opcode
 *  opens a new evolutionary niche — beings that use it can thrive;
 *  beings that don't, won't. When you add SENSE_SETTLEMENT later,
 *  some lineage will discover how to build near settlements. That's
 *  the whole mechanism.
 * ══════════════════════════════════════════════════════════════════════ */
 export function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const BeingVM = (() => {
const OP = {
  NOP:            0x00,
  PUSH:           0x01,
  DROP:           0x02,
  DUP:            0x03,
  ADD:            0x04,
  SUB:            0x05,
  LT:             0x06,
  JMP:            0x07,
  JZ:             0x08,
  SENSE_FOOD_X:   0x09,
  SENSE_FOOD_Z:   0x0A,
  SENSE_ENERGY:   0x0B,
  SENSE_NEIGHBOR: 0x0C,
  MOVE:           0x0D,
  EAT:            0x0E,
  REPRODUCE:      0x0F,
  SELF_READ:      0x10,
  LEARN:          0x11,
  MUTATE:         0x12,
  SENSE_TRAIL_FOOD:   0x13,
  SENSE_TRAIL_CUSTOM: 0x14,
  DEPOSIT_FOOD:       0x15,
  DEPOSIT_DANGER:     0x16,
  DEPOSIT_CUSTOM:     0x17,

  // ── The interior ──────────────────────────────────────────
  DATA_READ:          0x18,   // pop idx, push data[idx]
  DATA_WRITE:         0x19,   // pop val, pop idx, data[idx] = val
  INHERIT:            0x1A,   // pop src, pop dst; data[dst] = donor.data[src]

  // ── The exterior ──────────────────────────────────────────
  BUILD:              0x1B,   // no args; build or refresh a structure here
  SENSE_STRUCTURE_X:  0x1C,   // push dx toward nearest structure
  SENSE_STRUCTURE_Z:  0x1D,   // push dz
  STRUCTURE_READ:     0x1E,
  STRUCTURE_WRITE:    0x1F,
  STRUCTURE_CONSUME:  0x20,   // no args; destroy nearest structure, gain energy

  // ── The voice ─────────────────────────────────────────────
  SENSE_NEIGHBOR_DATA: 0x21,  // pop idx; push nearest neighbor's data[idx], or 0
  SIGNAL_NEIGHBOR:     0x22,  // pop val, pop idx; write val into nearest
                              // neighbor's data[idx]; costs a small amount
                              // of energy

  // ── The hunt ──────────────────────────────────────────────
  ATTACK:              0x23,  // strike nearest being within 60 units
  SENSE_NEIGHBOR_X:    0x24,  // push dx toward nearest being
  SENSE_NEIGHBOR_Z:    0x25,  // push dz

  // ── The harvest ───────────────────────────────────────────
  SCAVENGE:            0x26,  // eat nearest corpse
  SENSE_CORPSE_X:      0x27,  // push dx toward nearest corpse
  SENSE_CORPSE_Z:      0x28,  // push dz toward nearest corpse

  // ── The interior (state layer) ────────────────────────────
  SENSE_STATE:         0x29,  // pop slot index 0..7; push that state slot
                              // scaled to an integer the stack can hold.
                              // This is the ONLY way a program reads the
                              // state directly. Everything else is the
                              // state biasing the body underneath the
                              // program's awareness.

  // ── The self ─────────────────────────────────────────────
  SENSE_SELF:          0x2B,  // no args. Push the fused state as a
                              // single scalar. All slots are summed
                              // and passed through a saturating
                              // nonlinearity, so the program CANNOT
                              // decompose the result back into its
                              // parts. This is the being reading its
                              // own ego — not as a report on the
                              // components, but as a single felt
                              // value. It costs nothing, because the
                              // state is already there. It is free
                              // because a self is not a perception.
                              // It is what the being already is.

  // ── The other side of the world ─────────────────────────
  SENSE_DANGER_X:      0x2C,
  SENSE_DANGER_Z:      0x2D,

  // ── The library (subroutines) ─────────────────────────
  CALL:                0x2E,
  RET:                 0x2F,

  // ── The merge ─────────────────────────────────────────────
  ENGULF:              0x30,
  INVOKE_SYMBIONT:     0x31,
  RELEASE_SYMBIONT:    0x32,

  // ── The self-model ────────────────────────────────────────
  PREDICT_SELF:        0x33,
  SELF_ERROR:          0x34,
  // ── The persistent self ───────────────────────────────────
  SELF_TRACE:          0x57,   // push running-average of fused self
  SELF_VARIANCE:       0x58,   // push variance of fused self over time
  VALENCE:             0x56,

  // ── Episodic memory ──────────────────────────────────────
  REMEMBER:            0x50,
  RECALL:              0x51,   // pop idx, push state at (head - idx)
  REPLAY:              0x52,   // pop horizon; push predicted fused self
  CREDIT:              0x53,   // pop delay; credit action at (head - delay)
  EPISODE_LEN:         0x54,   // push number of steps stored
  EPISODE_REWARD:      0x55,   // push reward at (head - imm)

  // ── The world model ──────────────────────────────────────
  PREDICT_WORLD:       0x60,   // push predicted next fused self
  WORLD_ERROR:         0x61,   // push world-model prediction error
  IMAGINE:             0x62,   // pop horizon; push fused self N steps out
  BIND_ACTION:         0x63,  // pop world-channel index; push φ(g, W)
                              // — the bound action bias that uses both
                              // the fused self and the world model.
  SENSE_OTHER_SELF:    0x64,  // push ĝ_other × 80
  SENSE_G2:            0x65,  // push g₂ × 80
  BIND_SOCIAL:         0x66,  // pop world-channel; push φ(g₂, W) × 80

  // ── The composition layer (Patch 1d / 2 / 7) ─────────────
  BIND:                0x67,  // pop j, pop i; S[j+24] = tanh(S[i]*S[j+24])
  CALL_IND:            0x68,  // pop addr; call
  READ_PROGRAM:        0x69,  // pop len, pop dst, pop src; copy from nearest struct
  STRUCTURE_WRITE_PROG:0x6A,  // pop len, pop dst, pop src; write to nearest struct
  ASSIMILATE:          0x6B,  // failed digestion → incorporation
  FORM:                0x6C,  // pop comp (0 or 1), pop slot; form[comp] = tanh(S[slot])
};


  const OP_NAMES = Object.keys(OP);
  const OP_BY_VALUE = {};
  for (const k of OP_NAMES) OP_BY_VALUE[OP[k]] = k;

  const LEN_MAX      = 4096;     // physical cap
  const LEN_MASK     = LEN_MAX - 1;
  const LEN_SOFT     = 348;      // soft cap — mutation above this is slower
  const STACK_MAX    = 32;       // deep enough for subroutine chains
  const RET_STACK_MAX = 8;
  const INSTR_PER_STEP = 5;

  // ── Seeding a random program ────────────────────────────────────
  function makeRandom(rng){
  const len = 8 + Math.floor(rng() * 32);
  const prog = new Uint8Array(LEN_MAX);
  for (let i = 0; i < len; i++){
    prog[i] = OP[OP_NAMES[(rng() * OP_NAMES.length) | 0]];
  }
  return prog;
}

  // ── A few hand-written starter programs so gen-0 isn't all noise ──
  //   eater:   sense food → move → eat → reproduce → loop
  //   wanderer: move a fixed direction → eat → reproduce → loop
  //   hider:   sense energy, if low do nothing, else eat → reproduce
   const STARTER_PROGRAMS = {
    // Sense food, ADD a fallback (5, 3) ...
    eater: new Uint8Array([
      OP.SENSE_FOOD_X,
      OP.SENSE_FOOD_Z,
      OP.MOVE, OP.EAT,
      OP.DEPOSIT_FOOD,
      OP.REPRODUCE,
      OP.PUSH, 0, OP.JZ, 0,
    ]),
    // wanderer: no senses, just keep moving. Deposits its own custom mark.
    wanderer: new Uint8Array([
      OP.PUSH, 3, OP.PUSH, 5, OP.MOVE,
      OP.EAT, OP.DEPOSIT_CUSTOM,
      OP.REPRODUCE,
      OP.PUSH, 0, OP.JZ, 0,
    ]),
    // mapper: eats AND lights up the food trail so the followers can find it.
    mapper: new Uint8Array([
      OP.SENSE_FOOD_X,
      OP.SENSE_FOOD_Z,
      OP.MOVE, OP.EAT,
      OP.DEPOSIT_FOOD,
      OP.DEPOSIT_FOOD,
      OP.REPRODUCE,
      OP.PUSH, 0, OP.JZ, 0,
    ]),
    // follower: has no food sense at all — hunts by smell alone.
    follower: new Uint8Array([
      OP.SENSE_TRAIL_FOOD,
      OP.MOVE, OP.EAT,
      OP.REPRODUCE,
      OP.PUSH, 0, OP.JZ, 0,
    ]),

    // selfReader: the eater's cousin, but it consults its own AROUSAL
    // slot before acting. When AROUSAL is negative (the body is
    // calming), it drifts slowly. When AROUSAL is non-negative (the
    // body is activating), it hunts food aggressively.
    //
    //  byte   opcode
    //  0-1    PUSH 0        ; slot 0 = AROUSAL
    //  2      SENSE_STATE   ; push AROUSAL * 40
    //  3-4    PUSH 0
    //  5      LT            ; 1 if AROUSAL < 0, else 0
    //  6-7    JZ 15         ; if AROUSAL >= 0, jump to pos 15
    //  8-9    PUSH 1
    //  10-11  PUSH 1
    //  12     MOVE          ; slow drift
    //  13     EAT
    //  14     REPRODUCE
    //  15     SENSE_FOOD_X
    //  16-17  PUSH 5 ADD
    //  18     SENSE_FOOD_Z
    //  19-20  PUSH 3 ADD
    //  21     MOVE
    //  22     EAT
    //  23     REPRODUCE
    //  24-25  PUSH 0
    //  26-27  JZ 0          ; loop to start
    selfReader: new Uint8Array([
      OP.PUSH, 0, OP.SENSE_STATE,
      OP.PUSH, 0, OP.LT,
      OP.JZ, 17,   // SENSE_FOOD_X moved from 15 to 17 after JMP insertion
      OP.PUSH, 1, OP.PUSH, 1, OP.MOVE,
      OP.EAT,
      OP.REPRODUCE,
      OP.JMP, 28,   // skip the chase branch; jump to loop-back
      OP.SENSE_FOOD_X,
      OP.PUSH, 5, OP.ADD,
      OP.SENSE_FOOD_Z,
      OP.PUSH, 3, OP.ADD,
      OP.MOVE, OP.EAT,
      OP.REPRODUCE,
      OP.PUSH, 0, OP.JZ, 0,
    ]),

    // egoReader: the selfReader's successor. It reads the FUSED
    // state — a single scalar that no program can decompose into
    // slots. When the fused self is negative, the being drifts
    // slowly and conservatively. When it is positive, the being
    // hunts food. The being cannot ask which of its parts
    // contributed. It reads itself as a whole.
    //
    //  byte   opcode
    //  0      SENSE_SELF      ; push fused self * 80
    //  1-2    PUSH 0
    //  3      LT              ; 1 if fused < 0
    //  4-5    JZ 17           ; if fused >= 0, jump to chase branch
    //  6-7    PUSH 1
    //  8-9    PUSH 1
    //  10     MOVE            ; slow drift
    //  11     EAT
    //  12     REPRODUCE
    //  13-14  PUSH 0
    //  15-16  JZ 0            ; loop back to start
    //  17     SENSE_FOOD_X
    //  18-19  PUSH 5
    //  20     ADD
    //  21     SENSE_FOOD_Z
    //  22-23  PUSH 3
    //  24     ADD
    //  25     MOVE
    //  26     EAT
    //  27     REPRODUCE
    //  28-29  PUSH 0
    //  30-31  JZ 0
    egoReader: new Uint8Array([
      OP.SENSE_SELF,          // 0
      OP.PUSH, 0,             // 1-2
      OP.LT,                  // 3
      OP.JZ, 18,              // 4-5  → fused >= 0: jump to byte 18
      OP.SENSE_FOOD_X,        // 6    fused < 0 branch: hunt slow
      OP.PUSH, 1, OP.SUB,     // 7-9
      OP.SENSE_FOOD_Z,        // 10
      OP.PUSH, 1, OP.SUB,     // 11-13
      OP.MOVE, OP.EAT,        // 14-15
      OP.JMP, 28,             // 16-17
      OP.SENSE_FOOD_X,        // 18   fused >= 0 branch: hunt normal
      OP.PUSH, 5, OP.ADD,     // 19-21
      OP.SENSE_FOOD_Z,        // 22
      OP.PUSH, 3, OP.ADD,     // 23-25
      OP.MOVE, OP.EAT,        // 26-27
      OP.REPRODUCE,           // 28   both branches converge here
      OP.PUSH, 0, OP.JZ, 0,   // 29-32
    ]),


    // stateNavigator: senses food every loop, but does not move on the
    // raw noisy dx/dz. Instead, it lets the sense update state[4] and
    // state[5] (the running food-direction biases), then reads those
    // slots and moves by the integrated value. The state acts as a
    // low-pass filter over noisy senses. Under noise, this should
    // outcompete direct-sensing eaters.
    stateNavigator: new Uint8Array([
      OP.SENSE_FOOD_X,   // 0
      OP.DROP,           // 1
      OP.SENSE_FOOD_Z,   // 2
      OP.DROP,           // 3
      OP.PUSH, 4,        // 4-5
      OP.SENSE_STATE,    // 6
      OP.PUSH, 5,        // 7-8
      OP.SENSE_STATE,    // 9
      OP.MOVE,           // 10
      OP.EAT,            // 11
      OP.REPRODUCE,      // 12
      OP.PUSH, 0,        // 13-14
      OP.JZ, 0,          // 15-16
    ]),

    // builder: eats, then tries to build a structure at its own location.
    builder: new Uint8Array([
      OP.SENSE_FOOD_X,
      OP.SENSE_FOOD_Z,
      OP.MOVE, OP.EAT,
      OP.BUILD,
      OP.REPRODUCE,
      OP.PUSH, 0, OP.JZ, 0,
    ]),

    // scholar: eats, then reads a byte from the nearest structure.
    scholar: new Uint8Array([
      OP.SENSE_FOOD_X,
      OP.SENSE_FOOD_Z,
      OP.MOVE, OP.EAT,
      OP.PUSH, 0,
      OP.PUSH, 0,
      OP.STRUCTURE_READ,
      OP.REPRODUCE,
      OP.PUSH, 0, OP.JZ, 0,
    ]),

    // predator: hunts the nearest being. No food sense at all —
    //           it lives on flesh or it dies.
    predator: new Uint8Array([
      OP.SENSE_NEIGHBOR_X,
      OP.PUSH, 3, OP.ADD,
      OP.SENSE_NEIGHBOR_Z,
      OP.PUSH, 2, OP.ADD,
      OP.MOVE,
      OP.ATTACK,
      OP.REPRODUCE,
      OP.PUSH, 0, OP.JZ, 0,
    ]),

    // assimilator: hunts. When near prey, it attacks and then
    //              assimilates. Each kill adds a portion of the
    //              prey's fused state to its own. Over a lifetime
    //              it accumulates the memory of everything it eats.
    assimilator: new Uint8Array([
      OP.SENSE_NEIGHBOR_X,
      OP.PUSH, 3, OP.ADD,
      OP.SENSE_NEIGHBOR_Z,
      OP.PUSH, 2, OP.ADD,
      OP.MOVE,
      OP.ATTACK,
      OP.ASSIMILATE,
      OP.REPRODUCE,
      OP.PUSH, 0, OP.JZ, 0,
    ]),

    // weigher: the first program in this file that has to hold two
    // signals at once and act on their relationship. It senses where
    // the nearest danger is and where the nearest food is, and it
    // moves to food_x - danger_x, food_z - danger_z. If only food is
    // in range, that is just food-seeking. If only danger is in range,
    // it moves away. If both, it weighs them against each other. The
    // being cannot see this subtraction. It only sees the resulting
    // motion. But the state layer underneath it — the field every
    // being carries — is now receiving two channels and having to
    // hold them simultaneously. This is the substrate your theory
    // needs in order to be tested. Whether the state stays at the
    // floor or rises is the answer.
    weigher: new Uint8Array([
      OP.SENSE_FOOD_X,
      OP.SENSE_FOOD_Z,
      OP.SENSE_DANGER_X,
      OP.SENSE_DANGER_Z,
      OP.MOVE, OP.EAT,
      OP.REPRODUCE,
      OP.PUSH, 0, OP.JZ, 0,
    ]),

    stepper: new Uint8Array([
      OP.SENSE_SELF,               // 0
      OP.PUSH, 0,                  // 1-2
      OP.LT,                       // 3
      OP.JZ, 21,                   // 4-5
      OP.SENSE_FOOD_X,             // 6
      OP.PUSH, 5, OP.ADD,          // 7-9
      OP.SENSE_FOOD_Z,             // 10
      OP.PUSH, 3, OP.ADD,          // 11-13
      OP.MOVE, OP.EAT,             // 14-15
      OP.REPRODUCE,                // 16
      OP.PUSH, 0, OP.JZ, 0,        // 17-20
      OP.PUSH, 1, OP.PUSH, 1, OP.MOVE, // 21-25
      OP.PUSH, 0, OP.JZ, 0,        // 26-29
    ]),

    // caller: a being with a subroutine. The main loop calls into
    // the library region (bytes 32+) rather than inlining behavior.
    // This is the first program whose hot path is not its entire
    // program. The subroutine can evolve independently of the loop
    // that calls it. Selection decides whether the indirection pays.
    caller: new Uint8Array([
      OP.CALL, 32,               // 0-1: call subroutine at byte 32
      OP.REPRODUCE,              // 2
      OP.PUSH, 0,                // 3-4
      OP.JZ, 0,                  // 5-6: loop back to CALL
      // 7..31: padding
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0,
      // 32: library routine — seek food and eat
      OP.SENSE_FOOD_X,           // 32
      OP.PUSH, 5, OP.ADD,        // 33-35
      OP.SENSE_FOOD_Z,           // 36
      OP.PUSH, 3, OP.ADD,        // 37-39
      OP.MOVE, OP.EAT,           // 40-41
      OP.RET,                    // 42
    ]),

    // engulfer: hunts for a smaller neighbor, engulfs it, then
    // invokes the symbiont's program on every subsequent loop.
    engulfer: new Uint8Array([
      OP.SENSE_NEIGHBOR_X,
      OP.PUSH, 3, OP.ADD,
      OP.SENSE_NEIGHBOR_Z,
      OP.PUSH, 2, OP.ADD,
      OP.MOVE,
      OP.ENGULF,
      OP.PUSH, 0,
      OP.INVOKE_SYMBIONT,
      OP.EAT,
      OP.REPRODUCE,
      OP.PUSH, 0, OP.JZ, 0,
    ]),

    // metacognizer: reads its fused self. If negative, it consults
    // its self-model — the prediction error of its own next state.
    // Well-predicted (error < 20) → drift gently, trust the model.
    // Poorly-predicted (error >= 20) → move hard, explore. If fused
    // self is non-negative, hunt food normally. The first starter
    // program whose control flow depends on its own uncertainty.
    metacognizer: new Uint8Array([
      OP.SENSE_SELF,           // 0
      OP.PUSH, 0,              // 1-2
      OP.LT,                   // 3
      OP.JZ, 24,               // 4-5   → fused >= 0: hunt at 24
      OP.SELF_ERROR,           // 6
      OP.PUSH, 20,             // 7-8
      OP.LT,                   // 9
      OP.JZ, 19,               // 10-11 → error >= 20: explore at 19
      // drift branch (well-predicted, negative fused)
      OP.PUSH, 1,              // 12-13
      OP.PUSH, 1,              // 14-15
      OP.MOVE,                 // 16
      OP.JMP, 33,              // 17-18 → skip to tail
      // explore branch (poorly-predicted, negative fused)
      OP.PUSH, 4,              // 19-20
      OP.PUSH, 4,              // 21-22
      OP.MOVE,                 // 23
      // hunt branch (fused >= 0), and fall-through from explore
      OP.SENSE_FOOD_X,         // 24
      OP.PUSH, 5, OP.ADD,      // 25-27
      OP.SENSE_FOOD_Z,         // 28
      OP.PUSH, 3, OP.ADD,      // 29-31
      OP.MOVE,                 // 32
      // tail
      OP.EAT,                  // 33
      OP.REPRODUCE,            // 34
      OP.PUSH, 0,              // 35-36
      OP.JZ, 0,                // 37-38
    ]),

    // chronos: remembers its state at every step. When energy is
    // low, it recalls the state it had 20 steps ago and compares.
    // If the recalled state was richer than the current one, it
    // reverses course. If not, it continues. The first program
    // whose decision depends on its own history rather than on
    // what it is sensing right now.
    //
    //  byte   opcode
    //  0      REMEMBER           ; checkpoint
    //  1      SENSE_SELF
    //  2-3    PUSH 0
    //  4      LT
    //  5-6    JZ 20              ; fused >= 0 → hunt
    //  7-8    PUSH 20            ; delay = 20
    //  9      RECALL
    //  10     PUSH 0
    //  11     LT                 ; 1 if recalled < 0 (state was worse)
    //  12-13  JZ 17              ; if recalled >= 0, drift
    //  14-15  PUSH 2
    //  16     PUSH 2
    //  17     MOVE
    //  18     EAT
    //  19     JMP 29
    //  20     SENSE_FOOD_X
    //  21-22  PUSH 5
    //  23     ADD
    //  24     SENSE_FOOD_Z
    //  25-26  PUSH 3
    //  27     ADD
    //  28     MOVE
    //  29     EAT
    //  30     REPRODUCE
    //  31-32  PUSH 0
    //  33-34  JZ 0
    hedger: new Uint8Array([
      OP.VALENCE,
      OP.PUSH, 0, OP.LT,
      OP.JZ, 17,
      OP.PUSH, -3, OP.PUSH, -3, OP.MOVE,
      OP.EAT,
      OP.REPRODUCE,
      OP.PUSH, 0, OP.JZ, 0,
      OP.SENSE_FOOD_X,
      OP.PUSH, 5, OP.ADD,
      OP.SENSE_FOOD_Z,
      OP.PUSH, 3, OP.ADD,
      OP.MOVE, OP.EAT,
      OP.REPRODUCE,
      OP.PUSH, 0, OP.JZ, 0,
    ]),

    binder: new Uint8Array([
      OP.SENSE_FOOD_X, OP.PUSH, 5, OP.ADD,
      OP.SENSE_FOOD_Z, OP.PUSH, 3, OP.ADD,
      OP.PUSH, 4, OP.BIND_ACTION,
      OP.ADD,
      OP.MOVE,
      OP.EAT,
      OP.REPRODUCE,
      OP.PUSH, 0, OP.JZ, 0,
    ]),

    cultureReader: new Uint8Array([
      OP.SENSE_G2,
      OP.PUSH, 0, OP.LT,
      OP.JZ, 17,
      OP.PUSH, 1, OP.PUSH, 1, OP.MOVE, OP.EAT,
      OP.REPRODUCE,
      OP.PUSH, 0, OP.JZ, 0,
      OP.SENSE_FOOD_X, OP.PUSH, 5, OP.ADD,
      OP.SENSE_FOOD_Z, OP.PUSH, 3, OP.ADD,
      OP.MOVE, OP.EAT,
      OP.REPRODUCE,
      OP.PUSH, 0, OP.JZ, 0,
    ]),
    // weigher2: uses valence as a WEIGHT, not a panic. Positive
    // valence → full-speed hunt. Negative valence → half-speed hunt.
    // Never retreats. Uses the common currency to modulate effort
    // rather than abandon the pursuit. This is what a currency is
    // for. Contrast with hedger, which reads the same signal and
    // immediately abandons the food it was walking toward.
    //
    //  byte   opcode
    //  0      VALENCE
    //  1-2    PUSH 0
    //  3      LT
    //  4-5    JZ 16          ; valence >= 0 → positive-valence branch
    //  6      SENSE_FOOD_X
    //  7-8    PUSH 2
    //  9      SUB            ; dx - 2
    //  10     SENSE_FOOD_Z
    //  11-12  PUSH 2
    //  13     SUB            ; dz - 2
    //  14-15  JMP 24          ; skip to tail
    //  16     SENSE_FOOD_X
    //  17-18  PUSH 5
    //  19     ADD            ; dx + 5
    //  20     SENSE_FOOD_Z
    //  21-22  PUSH 3
    //  23     ADD            ; dz + 3
    //  24     MOVE
    //  25     EAT
    //  26     REPRODUCE
    //  27-28  PUSH 0
    //  29-30  JZ 0
    weigher2: new Uint8Array([
      OP.VALENCE,
      OP.PUSH, 0, OP.LT,
      OP.JZ, 16,
      OP.SENSE_FOOD_X,
      OP.PUSH, 2, OP.SUB,
      OP.SENSE_FOOD_Z,
      OP.PUSH, 2, OP.SUB,
      OP.JMP, 24,
      OP.SENSE_FOOD_X,
      OP.PUSH, 5, OP.ADD,
      OP.SENSE_FOOD_Z,
      OP.PUSH, 3, OP.ADD,
      OP.MOVE, OP.EAT,
      OP.REPRODUCE,
      OP.PUSH, 0, OP.JZ, 0,
    ]),

    chronos: new Uint8Array([
      OP.REMEMBER,
      OP.SENSE_SELF,
      OP.PUSH, 0, OP.LT,
      OP.JZ, 22,
      OP.PUSH, 20, OP.RECALL,
      OP.PUSH, 0, OP.LT,
      OP.JZ, 19,
      OP.PUSH, 2, OP.PUSH, 2, OP.MOVE,
      OP.EAT,
      OP.JMP, 29,
      OP.SENSE_FOOD_X, OP.PUSH, 5, OP.ADD,
      OP.SENSE_FOOD_Z, OP.PUSH, 3, OP.ADD,
      OP.MOVE,
      OP.EAT, OP.REPRODUCE,
      OP.PUSH, 0, OP.JZ, 0,
    ]),

    indirect: new Uint8Array([
      OP.PUSH, 40, OP.PUSH, 0,  OP.DATA_WRITE,
      OP.PUSH, 44, OP.PUSH, 1,  OP.DATA_WRITE,
      OP.PUSH, 52, OP.PUSH, 2,  OP.DATA_WRITE,
      OP.PUSH, 58, OP.PUSH, 3,  OP.DATA_WRITE,
      OP.PUSH, 0, OP.DATA_READ,
      OP.CALL_IND,
      OP.REPRODUCE,
      OP.PUSH, 0, OP.JZ, 0,
      0,0,0,0,0,0,0,0,0,0,0,
      OP.SENSE_TRAIL_FOOD, OP.MOVE, OP.EAT, OP.RET,
      OP.SENSE_FOOD_X, OP.PUSH, 5, OP.ADD,
      OP.SENSE_FOOD_Z, OP.PUSH, 3, OP.ADD,
      OP.MOVE, OP.EAT, OP.RET,
      OP.PUSH, 1, OP.PUSH, 1, OP.MOVE, OP.EAT, OP.RET,
      OP.SENSE_DANGER_X, OP.PUSH, 2, OP.SUB,
      OP.SENSE_DANGER_Z, OP.PUSH, 2, OP.SUB,
      OP.MOVE, OP.RET,
    ]),

    reader: new Uint8Array([
      OP.SENSE_FOOD_X, OP.PUSH, 5, OP.ADD,
      OP.SENSE_FOOD_Z, OP.PUSH, 3, OP.ADD,
      OP.MOVE, OP.EAT,
      OP.PUSH, 0, OP.PUSH, 40, OP.PUSH, 15,
      OP.READ_PROGRAM,
      OP.REPRODUCE,
      OP.PUSH, 0, OP.JZ, 0,
    ]),

  };



  function makeSeed(name, rng){
    const src = STARTER_PROGRAMS[name];
    if (!src) return makeRandom(rng);
    const prog = new Uint8Array(LEN_MAX);
    prog.set(src);
    // Small perturbation so gen-0 isn't perfectly clonal
    mutateProgramInPlace(prog, rng, 1);
    return prog;
  }

  // ── Mutation ────────────────────────────────────────────────────
  //   isChild  → 1–3 events (on reproduction)
  //   else     → 1 event (from the MUTATE opcode)
  function mutateProgram(src, rng, isChild){
    const out = new Uint8Array(LEN_MAX);
    out.set(src);
    mutateProgramInPlace(out, rng, isChild ? (1 + Math.floor(rng() * 3)) : 1);
    return out;
  }

  function mutateProgramInPlace(out, rng, events){
    const orig = new Uint8Array(LEN_MAX);
    orig.set(out);

    // Logical length: last non-zero byte
    let len = LEN_MAX;
    while (len > 4 && out[len - 1] === 0) len--;

    let hadRepro = false;
    for (let i = 0; i < len; i++){
      if (out[i] === OP.REPRODUCE) { hadRepro = true; break; }
    }

    for (let e = 0; e < events; e++){
      // Above LEN_SOFT, favor deletion and point mutation so programs
      // do not bloat without bound. Below LEN_SOFT, all operators active.
      const softBias = len > LEN_SOFT;
      const kind = rng();

      if (kind < 0.45){
        // Point mutation
        const i = (rng() * len) | 0;
        out[i] = OP[OP_NAMES[(rng() * OP_NAMES.length) | 0]];
      } else if (!softBias && kind < 0.60 && len < LEN_MAX - 2){
        // Insertion
        const i = (rng() * len) | 0;
        for (let j = len; j > i; j--) out[j] = out[j - 1];
        out[i] = OP[OP_NAMES[(rng() * OP_NAMES.length) | 0]];
        len++;
      } else if (kind < 0.75 && len > 8){
        // Deletion
        const i = (rng() * len) | 0;
        for (let j = i; j < len - 1; j++) out[j] = out[j + 1];
        out[len - 1] = 0;
        len--;
      } else if (!softBias && kind < 0.88 && len < LEN_MAX - 8){
        // Gene duplication — copy a run to a new location.
        // This is the operator that lets a lineage accumulate
        // complexity: duplicated code can drift into a new function
        // while the original keeps doing its job.
        const runLen   = 4 + ((rng() * 16) | 0);
        const srcStart = (rng() * Math.max(1, len - runLen)) | 0;
        const dstStart = (rng() * len) | 0;
        for (let k = 0; k < runLen; k++){
          const idx = dstStart + k;
          if (idx >= LEN_MAX) break;
          out[idx] = out[(srcStart + k) % len];
        }
        // Recompute len from the highest non-zero index. The
        // previous forward scan stopped at the first zero byte,
        // which means a duplication that wrote past an existing
        // zero left non-zero bytes beyond `len` that the next
        // mutation event could not reach. Those bytes accumulated
        // length tax without being executed. Recompute from the
        // tail instead.
        let newLen = LEN_MAX;
        while (newLen > 4 && out[newLen - 1] === 0) newLen--;
        len = newLen;
      } else if (kind < 0.94){
        // Swap adjacent bytes
        const i = (rng() * Math.max(1, len - 1)) | 0;
        const t = out[i]; out[i] = out[i + 1]; out[i + 1] = t;
      } else {
        // Module extraction: find a repeated 6-byte run and lift it
        // to a CALL target at the end. This is how library structure
        // can emerge without being designed in.
        const runLen = 6;
        if (len < LEN_MAX - runLen - 4){
          let bestStart = -1, bestCount = 0;
          for (let s = 0; s < len - runLen; s++){
            let count = 0;
            for (let t = s + 1; t < len - runLen; t++){
              let match = true;
              for (let k = 0; k < runLen; k++){
                if (out[s + k] !== out[t + k]) { match = false; break; }
              }
              if (match) count++;
            }
            if (count > bestCount){ bestCount = count; bestStart = s; }
          }
          if (bestStart >= 0 && bestCount >= 2){
            const moduleAddr = len;
            for (let k = 0; k < runLen; k++){
              out[moduleAddr + k] = out[bestStart + k];
            }
            out[moduleAddr + runLen] = OP.RET;
            // Replace the first occurrence with CALL moduleAddr
            out[bestStart]     = OP.CALL;
            out[bestStart + 1] = moduleAddr;
            for (let k = 2; k < runLen; k++) out[bestStart + k] = OP.NOP;
            len = moduleAddr + runLen + 1;
          }
        }
      }
    }

    // Viability invariant — logical length only.
    // Scanning the full array was the bug: a mutation that pushed
    // REPRODUCE past the trailing zeros satisfied the invariant but
    // left the program functionally sterile. Every byte the PC never
    // reaches is dead code. The invariant must check what the
    // program will actually execute.
    if (hadRepro){
      let newLen = LEN_MAX;
      while (newLen > 4 && out[newLen - 1] === 0) newLen--;
      let hasRepro = false;
      for (let i = 0; i < newLen; i++){
        if (out[i] === OP.REPRODUCE) { hasRepro = true; break; }
      }
      if (!hasRepro) out.set(orig);
    }
  }

  // ── Disassembler for the console inspector ──────────────────────
  function disassemble(prog){
    const lines = [];
    let i = 0, safety = 0;
    while (i < LEN_MAX && safety < 2000){
      safety++;
      const op = prog[i];
      const name = OP_BY_VALUE[op] || ('?0x' + op.toString(16));
      const takesOperand = (
        op === OP.PUSH || op === OP.JMP || op === OP.JZ || op === OP.CALL ||
        op === OP.RECALL || op === OP.REPLAY || op === OP.CREDIT || op === OP.EPISODE_REWARD
      );
      if (takesOperand){
        lines.push(String(i).padStart(2) + ': ' + name.padEnd(14) + ' ' + prog[i + 1]);
        i += 2;
      } else {
        lines.push(String(i).padStart(2) + ': ' + name);
        i += 1;
      }
      // Stop after the trailing zero-run
      if (op === 0 && prog[i] === 0 && prog[i + 1] === 0) break;
    }
    return lines.join('\n');
  }

  return {
    OP, OP_NAMES, OP_BY_VALUE,
    LEN_MAX, LEN_SOFT, LEN_MASK, STACK_MAX, RET_STACK_MAX, INSTR_PER_STEP,
    DATA_SIZE: 32,
    EPISODE_LEN: 64,
    makeRandom, makeSeed, mutateProgram, disassemble,
    STARTER_PROGRAMS,
  };
})();

// ── Per-call scratch buffers. Reused across beings, across ticks.
//    Zeroed at each use site. Eliminates ~48K Float32Array
//    allocations per second at 2400 beings × 20 Hz.
const _inputsScratch  = new Float32Array(32);
const _stateScratchA  = new Float32Array(32);
const _stateScratchB  = new Float32Array(32);
const _hiddenScratch  = new Float32Array(16);

/* ══════════════════════════════════════════════════════════════════════
 *  STATE LAYER
 *  Called from worker.js each step, before the program runs.
 *  `b` is a cold being object. `world` is the worker's view object.
 *  `rng` is the worker's mulberry32.
 * ══════════════════════════════════════════════════════════════════════ */

export function updateState(b, world, rng, h){
  const S = b.state;
  const P = b._statePrev;
  const g = b.genes;
  const STATE_SIZE = world.STATE_SIZE;

  if (!b._predWeights){
    b._predWeights = new Float32Array(STATE_SIZE);
    b._predBias = 0;
    b._predictedFused = 0;
    b._predError = 0;
  }

  const e = b.energy;
  if (b._arousalRef === undefined) b._arousalRef = e;
  b._arousalRef = b._arousalRef * 0.98 + e * 0.02;
  const arousalInput = Math.max(-1, Math.min(1, (e - b._arousalRef) / 30));

  const satInput     = Math.max(-1, Math.min(1, (e - 80) / 75));
  const cellIdx      = Q.cellIndex(world, b.x, b.z);
  const threatInput  = Math.max(-1, Math.min(1, (world.fieldD[cellIdx] - 0.5) / 10));

  if (b._socialCacheTime === undefined || world.simTime - b._socialCacheTime > 0.25){
    b._socialCache     = Q.countBeingsInRadius(world, b.x, b.z, 400);
    b._socialCacheTime = world.simTime;
  }
  const socialInput  = Math.max(0, Math.min(1, b._socialCache / 8));
  const biasXInput   = Math.max(-1, Math.min(1, b.lastDirX || 0));
  const biasZInput   = Math.max(-1, Math.min(1, b.lastDirZ || 0));
  const traceInput   = Math.max(-1, Math.min(1, world.fieldF[cellIdx] / 15));
  const traceRecent  = S[7];

  const inputs = _inputsScratch;
  inputs.fill(0);
  inputs[0] = arousalInput;
  inputs[1] = satInput;
  inputs[2] = threatInput;
  inputs[3] = socialInput;
  inputs[4] = biasXInput;
  inputs[5] = biasZInput;
  inputs[6] = traceInput;
  inputs[7] = traceRecent;
  for (let i = 8; i < 24; i++){
    const j = i & 7;
    inputs[i] = inputs[j] * 0.5;
  }

  let mean = 0;
  for (let i = 0; i < STATE_SIZE; i++) mean += S[i];
  mean /= STATE_SIZE;

  const wIn   = b._effInput    ?? g.stateInput;
  const wCpl  = b._effCoupling ?? g.stateCoupling;
  const decay = b._effDecay    ?? g.stateDecay;
  const noiseAmp = 0.05;

  for (let i = 0; i < STATE_SIZE; i++) P[i] = S[i];

  for (let i = 0; i < 6; i++){
    const drive   = inputs[i] * wIn;
    const coupled = wCpl * (Math.tanh(mean * 1.6) - S[i]);
    const forget  = -decay * S[i];
    const jitter  = noiseAmp * (rng() - 0.5);
    S[i] += h * (drive + coupled + forget) + jitter * h;
    if (S[i] >  3) S[i] =  3;
    if (S[i] < -3) S[i] = -3;
  }
  const decayW = b._effDecayWorking ?? 0.01;
  for (let i = 8; i < 16; i++){
    const drive   = inputs[i] * wIn;
    const coupled = wCpl * 0.5 * (Math.tanh(mean * 1.6) - S[i]);
    const forget  = -decayW * S[i];
    const jitter  = noiseAmp * 0.5 * (rng() - 0.5);
    S[i] += h * (drive + coupled + forget) + jitter * h;
    if (S[i] >  3) S[i] =  3;
    if (S[i] < -3) S[i] = -3;
  }
  const decayI = b._effDecayIdentity ?? 0.0005;
  for (let i = 16; i < 24; i++){
    const drive   = inputs[i] * wIn * 0.2;
    const coupled = wCpl * 0.1 * (Math.tanh(mean * 1.6) - S[i]);
    const forget  = -decayI * S[i];
    S[i] += h * (drive + coupled + forget);
    if (S[i] >  3) S[i] =  3;
    if (S[i] < -3) S[i] = -3;
  }
  for (let i = 24; i < 32; i++){
    S[i] *= (1 - h * 0.002);
    if (S[i] >  3) S[i] =  3;
    if (S[i] < -3) S[i] = -3;
  }

  S[6] = S[6] * 0.997 + traceInput * 0.003;
  const tempoRate = Math.max(-1, Math.min(1, (S[0] - P[0]) / (h * 4)));
  S[7] = S[7] * 0.95 + tempoRate * 0.05;

  let posCount = 0, negCount = 0;
  for (let i = 0; i < STATE_SIZE; i++){
    const d = S[i] - P[i];
    if (d >  1e-3) posCount++;
    else if (d < -1e-3) negCount++;
  }
  const total = posCount + negCount;
  const kappaInst = total > 0 ? (1 - Math.abs(posCount - negCount) / total) : 0;
  if (b._kappaEMA === undefined) b._kappaEMA = 0.3;
  b._kappaEMA = b._kappaEMA * 0.995 + kappaInst * 0.005;

  b._valence = Math.tanh(
      satInput     * 1.2
    + arousalInput * 0.9
    - threatInput  * 0.8
    + socialInput  * 0.2
    + traceInput   * 0.3
  );

  b._stateAge += h;
  b._prevEnergy = e;

  let mag = 0, sum = 0;
  for (let i = 0; i < STATE_SIZE; i++){
    mag += Math.abs(S[i]);
    sum += S[i];
  }
  b._stateMag = mag;

  let fused = 0;
  if (b.genes.fusionEnabled){
    const pool  = world.IRRATIONAL_POOL;
    const seed  = b.genes.fusionSeed;
    const depth = b.genes.fusionDepth | 0;
    const str   = b.genes.fusionStrength;
    const base  = Math.floor(seed * pool.length) % pool.length;

    let structural = 0;
    structural += (b._valence ?? 0) * 2.0;
    structural += (b._selfTrace ?? 0) * 3.0;
    structural += satInput     * 0.6;
    structural -= threatInput  * 0.8;
    structural += socialInput  * 0.2;
    structural += arousalInput * 0.4;

    const W1 = b._mlpW1;
    const b1 = b._mlpB1;
    const W2 = b._mlpW2;
    const b2 = b._mlpB2;
    const hidden = _hiddenScratch;
    for (let h = 0; h < 16; h++) {
      let z = b1[h];
      const rowBase = h * STATE_SIZE;
      for (let i = 0; i < STATE_SIZE; i++) z += W1[rowBase + i] * S[i];
      hidden[h] = Math.tanh(z);
    }
    let chaotic = b2;
    for (let h = 0; h < 16; h++) chaotic += W2[h] * hidden[h];
    fused = structural + chaotic * 0.35 * str;
  } else {
    b._fusedSelf = 0;
  }

  if (b.symbionts){
    for (let si = 0; si < b.symbionts.length; si++){
      const sym = b.symbionts[si];
      for (let i = 0; i < STATE_SIZE; i++){
        const m = world.IRRATIONAL_POOL[(i + si) % world.IRRATIONAL_POOL.length] * (1 + si * 0.07);
        fused += Math.sin(sym.state[i] * m);
      }
      for (let i = 0; i < STATE_SIZE; i++){
        const sd = sym.genes.stateDecay || 0.5;
        const sc = sym.genes.stateCoupling || 0.5;
        sym.state[i] += h * (-sd * sym.state[i] + sc * (Math.tanh(mean * 1.6) - sym.state[i]));
        if (sym.state[i] >  3) sym.state[i] =  3;
        if (sym.state[i] < -3) sym.state[i] = -3;
      }
      if (sym.symbionts && sym.symbionts.length > 0){
        for (let ni = 0; ni < sym.symbionts.length; ni++){
          const nested = sym.symbionts[ni];
          for (let i = 0; i < STATE_SIZE; i++){
            const nm = world.IRRATIONAL_POOL[(i + ni) % world.IRRATIONAL_POOL.length];
            fused += Math.sin(nested.state[i] * nm * (1 + ni * 0.11));
          }
          for (let i = 0; i < STATE_SIZE; i++){
            const sd = nested.genes.stateDecay || 0.5;
            const sc = nested.genes.stateCoupling || 0.5;
            nested.state[i] += h * (-sd * nested.state[i] + sc * (Math.tanh(mean * 1.6) - nested.state[i]));
            if (nested.state[i] >  3) nested.state[i] =  3;
            if (nested.state[i] < -3) nested.state[i] = -3;
          }
        }
      }
    }
  }

  if (b.genes.fusionEnabled){
    if (!b._corrSum){
      b._corrSum = new Float32Array(STATE_SIZE);
      b._varS    = new Float32Array(STATE_SIZE);
      b._varF    = 0;
      b._corrWindow = 0;
      b._rhoEMA = 0.5;
      b._fusedPrev = 0;
    }
    const fNow = Math.tanh(fused * 0.55);
    const df = fNow - (b._fusedPrev ?? 0);
    b._varF = b._varF * 0.98 + df * df * 0.02;
    if (Math.abs(df) > 1e-4){
      for (let i = 0; i < STATE_SIZE; i++){
        const ds = S[i] - P[i];
        b._corrSum[i] = b._corrSum[i] * 0.98 + (df * ds) * 0.02;
        b._varS[i]    = b._varS[i]    * 0.98 + (ds * ds) * 0.02;
      }
      b._corrWindow++;
    }
    b._fusedPrev = fNow;
    if (b._corrWindow > 0 && (b._stateAge % 10) < h){
      let r2 = 0, cnt = 0;
      const vf = b._varF;
      if (vf > 1e-9){
        for (let i = 0; i < STATE_SIZE; i++){
          const vs = b._varS[i];
          if (vs < 1e-9) continue;
          const c = b._corrSum[i];
          r2 += (c * c) / (vf * vs);
          cnt++;
        }
      }
      r2 = cnt > 0 ? r2 / cnt : 0;
      b._rhoEMA = b._rhoEMA * 0.9 + Math.min(1, r2) * 0.1;
    }
    b._fusionValid = b._rhoEMA < 0.55;
    b._fusedSelf = b._fusionValid ? fNow : Math.tanh(fused * 0.20);

    b._selfTrace    = b._selfTrace * 0.995 + b._fusedSelf * 0.005;
    b._selfTraceVar = b._selfTraceVar * 0.995 + (b._fusedSelf - b._selfTrace) ** 2 * 0.005;
    b._selfTraceAge += h;
  }

  if (b._neighborCache && b._neighborCache.id !== undefined){
    const other = world.getBeingById(b._neighborCache.id);
    const otherG = other && !other.dead ? (other._fusedSelf ?? 0) : 0;
    b._otherFused = b._otherFused * 0.97 + otherG * 0.03;
    b._g2Ready = true;
  } else {
    b._otherFused *= 0.98;
  }
  if (b.genes.fusionEnabled && b._fusionValid !== false){
    const pool  = world.IRRATIONAL_POOL;
    const seed  = b.genes.fusionSeed;
    const depth = b.genes.fusionDepth | 0;
    const base  = Math.floor(seed * pool.length) % pool.length;
    const attn  = b.genes.fusionAttn;
    const fbias = b.genes.fusionBias || 0;
    const g2in  = [b._fusedSelf ?? 0, b._otherFused ?? 0];
    let g2chaos = 0, wsum = 1e-6;
    for (let i = 0; i < 2; i++){
      const mix = pool[(base + (STATE_SIZE + i) * depth) % pool.length];
      const w = attn ? attn[i % STATE_SIZE] : 1.0;
      g2chaos += w * Math.sin(g2in[i] * mix + fbias);
      wsum    += w;
    }
    g2chaos /= wsum;
    const g2struct = (b._fusedSelf ?? 0) * 1.0 + (b._otherFused ?? 0) * 0.6;
    b._g2 = Math.tanh((g2struct + g2chaos * 0.35) * 0.55);
  } else {
    b._g2 = 0;
  }

  let predicted = b._predBias;
  for (let i = 0; i < STATE_SIZE; i++) predicted += b._predWeights[i] * S[i];
  predicted = Math.tanh(predicted * 0.5);
  const predError = b._fusedSelf - predicted;
  const gPred = (1 - predicted * predicted) * predError * 0.01;
  for (let i = 0; i < STATE_SIZE; i++){
    b._predWeights[i] = Math.max(-2, Math.min(2, b._predWeights[i] + gPred * S[i] * 0.5));
  }
  b._predBias = Math.max(-2, Math.min(2, b._predBias + gPred));
  b._predictedFused = predicted;
  b._predError = predError;

  if (b._usesWorldModel) {
    if (!b._worldModel){
      b._worldModel = {
        W: new Float32Array(STATE_SIZE * STATE_SIZE),
        bias: 0,
        predictedFused: 0,
        predictionError: 0,
      };
    }
    const WM = b._worldModel;
    if (!WM.W_action) WM.W_action = new Float32Array(STATE_SIZE * 256);
    const actionByte = (b._lastAction || 0) & 0xFF;
    let wmErrSum = 0;
    for (let j = 0; j < STATE_SIZE; j++){
      let pred = WM.bias;
      const rowBase = j * STATE_SIZE;
      for (let i = 0; i < STATE_SIZE; i++) pred += WM.W[rowBase + i] * P[i];
      pred += WM.W_action[j * 256 + actionByte];
      const err = S[j] - pred;
      wmErrSum += err * err;
      for (let i = 0; i < STATE_SIZE; i++){
        WM.W[rowBase + i] = Math.max(-3, Math.min(3, WM.W[rowBase + i] + 0.001 * err * P[i]));
      }
      WM.W_action[j * 256 + actionByte] = Math.max(-3, Math.min(3, WM.W_action[j * 256 + actionByte] + 0.001 * err));
    }
  WM.bias = Math.max(-3, Math.min(3, WM.bias + 0.001 * wmErrSum * 0.1));
    WM.predictionError = Math.sqrt(wmErrSum / STATE_SIZE);
  }
}

export function updatePlasticity(b, dt){
  const g = b.genes;
  if (g.statePlasticity <= 0) return;

  const prevE = b._lastPlasticityEnergy ?? b.energy;
  const dE = Math.max(-30, Math.min(30, b.energy - prevE));
  b._lastPlasticityEnergy = b.energy;
  const signal = Math.max(-1, Math.min(1, dE / 5));

  const eta = 0.03;
  b._corrCoupling = (b._corrCoupling ?? 0) * 0.95 + eta * (b._effCoupling - 1.0) * signal;
  b._corrDecay    = (b._corrDecay    ?? 0) * 0.95 + eta * (b._effDecay    - 0.5) * signal;
  b._corrInput    = (b._corrInput    ?? 0) * 0.95 + eta * (b._effInput    - 1.0) * signal;

  const rate = g.statePlasticity * 0.008 * dt;
  const rule = g.plasticityRule || [1, 1, 1];
  b._effCoupling = Math.max(0.05, Math.min(3.0, b._effCoupling + rate * rule[0] * Math.tanh(b._corrCoupling * 3)));
  b._effDecay    = Math.max(0.02, Math.min(1.5, b._effDecay    + rate * rule[1] * Math.tanh(b._corrDecay    * 3)));
  b._effInput    = Math.max(0.50, Math.min(3.0, b._effInput    + rate * rule[2] * Math.tanh(b._corrInput    * 3)));
  b._effDecayWorking  = Math.max(0.001, Math.min(0.05,
    (b._effDecayWorking ?? 0.01) + rate * rule[1] * 0.0005 * Math.tanh(b._corrDecay * 2)));
  b._effDecayIdentity = Math.max(0.00005, Math.min(0.005,
    (b._effDecayIdentity ?? 0.0005) + rate * rule[1] * 0.00005 * Math.tanh(b._corrDecay * 2)));
}

/* ══════════════════════════════════════════════════════════════════════
 *  VM DISPATCHER
 *  Returns false if the program self-halted. Otherwise true.
 *  `b` is a cold being object owned by this worker.
 *  `world` is the worker's view object.
 *  `rng` is the worker's mulberry32.
 *
 *  Cross-worker mutations (attack a being in another chunk, deposit a
 *  corpse at a coordinate the master owns) are routed through the
 *  request ring. Local mutations are direct.
 * ══════════════════════════════════════════════════════════════════════ */

const BEING_STRIDE = 12;
const REQ_MASK     = 1023;

function pushRequest(world, type, a, b_, c, d, e, f, g){
  const hdr = world.reqhdr;
  const idx = Atomics.add(hdr, 0, 1) & REQ_MASK;
  const base = idx * 8;
  const R = world.request;
  R[base]     = type;
  R[base + 1] = a  ?? 0;
  R[base + 2] = b_ ?? 0;
  R[base + 3] = c  ?? 0;
  R[base + 4] = d  ?? 0;
  R[base + 5] = e  ?? 0;
  R[base + 6] = f  ?? 0;
  R[base + 7] = g  ?? 0;
}

export function executeOneInstruction(b, world, rng){
  const prog  = b.program;
  const stack = b.stack;
  let   pc    = b.pc;
  let   sp    = b.sp;
  const VM    = BeingVM;
  const OP    = VM.OP;

  if (pc < 0 || pc >= VM.LEN_MAX){ b.pc = 0; b.sp = 0; return false; }

  b._lastAction = prog[pc];
  if (!b._opUse) b._opUse = new Uint16Array(256);
  b._opUse[prog[pc]]++;
  const op = prog[pc];
  let nextPC = pc + 1;

  const push = (v) => { if (sp < VM.STACK_MAX) stack[sp++] = v | 0; };
  const pop  = () => (sp > 0 ? stack[--sp] : 0);

  switch (op){

    case OP.NOP: break;

    case OP.PUSH: {
      let v = prog[(pc + 1) & VM.LEN_MASK];
      if (v > 127) v -= 256;
      push(v);
      nextPC = pc + 2;
      break;
    }
    case OP.DROP: pop(); break;
    case OP.DUP: {
      if (sp > 0 && sp < VM.STACK_MAX) stack[sp++] = stack[sp - 1];
      break;
    }
    case OP.ADD: { const b1 = pop(), a1 = pop(); push(a1 + b1); break; }
    case OP.SUB: { const b1 = pop(), a1 = pop(); push(a1 - b1); break; }
    case OP.LT:  { const b1 = pop(), a1 = pop(); push(a1 < b1 ? 1 : 0); break; }
    case OP.JMP: nextPC = prog[(pc + 1) & VM.LEN_MASK] & VM.LEN_MASK; break;
    case OP.JZ: {
      const v = pop();
      nextPC = (v === 0)
        ? prog[(pc + 1) & VM.LEN_MASK] & VM.LEN_MASK
        : pc + 2;
      break;
    }

    case OP.SENSE_FOOD_X: {
      if (!b._foodCacheValid || world.simTime - b._foodCacheTime > 0.4){
        const boost = 1 + 0.6 * Math.min(1, (b._stateMag || 0) / 8);
        b._foodCache = Q.nearestFood(world, b.x, b.z, b.genes.sense * boost);
        b._foodCacheValid = true;
        b._foodCacheTime = world.simTime;
        b.energy -= world.SENSE_COST;
        world.ledger.addSink(world.SENSE_COST);
      }
      b._foodNoiseX = (rng() - 0.5) * 150;
      const f = b._foodCache;
      const dx = (f ? f.x - b.x : 0) + (b._foodNoiseX || 0);
      push(Math.max(-127, Math.min(127, Math.round(dx / 50))));
      if (f) b.state[4] = b.state[4] * 0.7 + Math.max(-1, Math.min(1, dx / 200)) * 0.3;
      break;
    }
    case OP.SENSE_FOOD_Z: {
      if (!b._foodCacheValid || world.simTime - b._foodCacheTime > 0.4){
        const boost = 1 + 0.6 * Math.min(1, (b._stateMag || 0) / 8);
        b._foodCache = Q.nearestFood(world, b.x, b.z, b.genes.sense * boost);
        b._foodCacheValid = true;
        b._foodCacheTime = world.simTime;
        b.energy -= world.SENSE_COST;
        world.ledger.addSink(world.SENSE_COST);
      }
      b._foodNoiseZ = (rng() - 0.5) * 150;
      const f = b._foodCache;
      const dz = (f ? f.z - b.z : 0) + (b._foodNoiseZ || 0);
      push(Math.max(-127, Math.min(127, Math.round(dz / 50))));
      if (f) b.state[5] = b.state[5] * 0.7 + Math.max(-1, Math.min(1, dz / 200)) * 0.3;
      break;
    }

    case OP.SENSE_ENERGY:
      push(Math.max(0, Math.min(255, Math.round(b.energy))));
      break;

    case OP.SENSE_NEIGHBOR: {
      const B = world.beings;
      const N = B.length / BEING_STRIDE;
      let best = 127;
      for (let k = 0; k < 20; k++){
        const id = (rng() * N) | 0;
        if (id === b.id) continue;
        const o = id * BEING_STRIDE;
        if (B[o + 11] === 0) continue;
        const dx = B[o] - b.x, dz = B[o + 2] - b.z;
        const dd = Math.round(Math.hypot(dx, dz) / 50);
        if (dd < best) best = dd;
      }
      push(best);
      break;
    }

    case OP.SENSE_NEIGHBOR_X: {
      if (!b._neighborCacheValid || world.simTime - b._neighborCacheTime > 0.4){
        const r = Q.nearestBeing(world, b.x, b.z, b.genes.sense, b.id);
        b._neighborCache = r ? { x: r.x, z: r.z, id: r.id } : null;
        b._neighborCacheValid = true;
        b._neighborCacheTime = world.simTime;
      }
      const near = b._neighborCache;
      const dx = near ? near.x - b.x : 0;
      push(Math.max(-127, Math.min(127, Math.round(dx / 50))));
      break;
    }
    case OP.SENSE_NEIGHBOR_Z: {
      if (!b._neighborCacheValid || world.simTime - b._neighborCacheTime > 0.4){
        const r = Q.nearestBeing(world, b.x, b.z, b.genes.sense, b.id);
        b._neighborCache = r ? { x: r.x, z: r.z, id: r.id } : null;
        b._neighborCacheValid = true;
        b._neighborCacheTime = world.simTime;
      }
      const near = b._neighborCache;
      const dz = near ? near.z - b.z : 0;
      push(Math.max(-127, Math.min(127, Math.round(dz / 50))));
      break;
    }

    case OP.ATTACK: {
      if (world.curriculum && !world.curriculum.predator) break;
      b.energy -= 1.5;
      world.ledger.addSink(1.5);
      const near = b._neighborCache;
      if (!near || near.id === undefined) break;
      const prey = world.getBeingById(near.id);
      if (prey && !prey.dead){
        prey.energy -= 15;
        b.energy     += 8;
        world.ledger.addSink(7);
        Q.depositDanger(world, prey.x, prey.z, 0.5);
      }
      break;
    }

    case OP.EAT: {
      if (b.state[1] >= 2.2) break;

      let idx = -1;
      if (b._foodCacheValid
          && world.simTime - b._foodCacheTime <= 0.4
          && b._foodCache){
        const c = b._foodCache;
        if (world.food[c.idx * 6 + 5] !== 0){
          const px = world.food[c.idx * 6 + 0];
          const pz = world.food[c.idx * 6 + 1];
          const dx = px - b.x, dz = pz - b.z;
          if (dx * dx + dz * dz <= 60 * 60) idx = c.idx;
        }
      }
      if (idx < 0){
        const nf = Q.nearestFood(world, b.x, b.z, 60);
        if (!nf) break;
        idx = nf.idx;
      }
      const gi = idx * 6;
      const actualGrowth = world.food[gi + 2];
      if (actualGrowth <= world.PLANT_EDIBLE_THRESH) break;
      const px = world.food[gi + 0];
      const pz = world.food[gi + 1];
      const harvest = actualGrowth * world.PLANT_FULL_ENERGY;
      b.energy += harvest;
      Q.depositFood(world, px, pz, -0.3 * actualGrowth);
      world.food[gi + 5] = 0;
      break;
    }

    case OP.MOVE: {
      let dz = pop();
      let dx = pop();
      const fused = b._fusedSelf ?? 0;
      const fuseMult = Math.max(0.25, Math.min(4.0, Math.pow(2, -fused * 2)));
      const biasX = b.state[4] * 0.20;
      const biasZ = b.state[5] * 0.20;
      dx = dx + biasX * 50;
      dz = dz + biasZ * 50;

      // Wander. If the program issued no direction — no food, no
      // danger, no neighbor in range — the being cannot stand still
      // or the population dies before discovery. Give it a per-being
      // wander direction. Deterministic (from b.id), slowly curving
      // (from b.age), so each being sweeps its own path through the
      // plane and eventually crosses food.
      if (Math.abs(dx) < 1 && Math.abs(dz) < 1){
        const ang = b.id * 2.399963229728653 + b.age * 0.08;
        dx = Math.cos(ang) * 4;
        dz = Math.sin(ang) * 4;
      }

      const step = 0.08 * b.genes.speed;
      const oldX = b.x, oldZ = b.z;
      // 60× multiplier, not 10×. Plane is ±50000; sense is 200–500.
      // At 10× a being needs its entire lifetime to leave its patch.
      b.x = Math.max(-world.planeSize, Math.min(world.planeSize, b.x + dx * step * 60));
      b.z = Math.max(-world.planeSize, Math.min(world.planeSize, b.z + dz * step * 60));
      const travelled = Math.hypot(b.x - oldX, b.z - oldZ);
      const moveCost = travelled * 0.003 * fuseMult;
      b.energy -= moveCost;
      world.ledger.addSink(moveCost);
      const m = Math.hypot(dx, dz) || 1;
      b.lastDirX = dx / m;
      b.lastDirZ = dz / m;
      b._neighborCacheTime = world.simTime;
      break;
    }

    case OP.SCAVENGE: {
      const c = Q.nearestCorpse(world, b.x, b.z, 60);
      if (!c || c.mass <= 5) break;
      const gained = Math.min(30, c.mass);
      b.energy += gained;
      b.energy -= 0.5;
      world.ledger.addSink(0.5);
      const _o = c.idx * 5;
      world.corpse[_o + 2] -= gained;
      if (world.corpse[_o + 2] < 1) world.corpse[_o + 4] = 0;
      break;
    }

    case OP.REPRODUCE: {
      if (b.state[0] < -0.5) {
        globalThis.worker_metrics.repro_blocked.arousal =
          (globalThis.worker_metrics.repro_blocked.arousal || 0) + 1;
        break;
      }
      if (b._pendingChild) {
        globalThis.worker_metrics.repro_blocked.pending =
          (globalThis.worker_metrics.repro_blocked.pending || 0) + 1;
        break;
      }
      const fused = b._fusedSelf ?? 0;
      const repCostMult = Math.max(0.354, Math.min(2.828, Math.pow(2, -fused * 1.5)));
      const rank = b._paretoRank ?? 999;
      const paretoFactor = Math.max(0.75, Math.min(1.4, 0.75 + Math.log2(rank + 1) * 0.10));
      const popFrac = world.worldhdr[4] / world.MAX_BEINGS;
      const popCost = 1 + popFrac * popFrac * 2;
      const childEnergy = b.genes.repCost * 1.8 * repCostMult * paretoFactor * popCost;
      if (b.age > b.genes.matAge
          && b.energy > childEnergy * 1.2
          && world.worldhdr[4] < world.MAX_BEINGS){
        b.energy -= childEnergy;
        b._pendingChild = { energy: childEnergy };
      } else {
        if (b.age <= b.genes.matAge) {
          globalThis.worker_metrics.repro_blocked.age =
            (globalThis.worker_metrics.repro_blocked.age || 0) + 1;
        } else if (b.energy <= childEnergy * 1.2) {
          globalThis.worker_metrics.repro_blocked.energy =
            (globalThis.worker_metrics.repro_blocked.energy || 0) + 1;
        } else {
          globalThis.worker_metrics.repro_blocked.popcap =
            (globalThis.worker_metrics.repro_blocked.popcap || 0) + 1;
        }
      }
      break;
    }

    case OP.SELF_READ: {
      const n = pop();
      const idx = ((n % 64) + 64) & VM.LEN_MASK;
      let v = prog[idx];
      if (v > 127) v -= 256;
      push(v);
      break;
    }

    case OP.LEARN: {
      const donor = Q.nearestBeing(world, b.x, b.z, 200, b.id);
      if (!donor) break;
      const donorBeing = world.getBeingById(donor.id);
      if (!donorBeing || !donorBeing.program) break;
      const i = (rng() * VM.LEN_MAX) | 0;
      const j = (rng() * VM.LEN_MAX) | 0;
      b.program[i] = donorBeing.program[j];
      break;
    }

    case OP.INHERIT: {
      const src = pop() & (VM.DATA_SIZE - 1);
      const dst = pop() & (VM.DATA_SIZE - 1);
      const donor = Q.nearestBeing(world, b.x, b.z, 200, b.id);
      if (!donor) break;
      const donorBeing = world.getBeingById(donor.id);
      if (!donorBeing || !donorBeing.data) break;
      if (donorBeing.energy <= b.energy) break;
      b.data[dst] = donorBeing.data[src];
      break;
    }

    case OP.SENSE_TRAIL_FOOD: {
      const r = Q.senseTrail(world, b.x, b.z, world.fieldF, 4);
      push(r.dx); push(r.dz);
      break;
    }
    case OP.SENSE_TRAIL_CUSTOM: {
      const r = Q.senseTrail(world, b.x, b.z, world.fieldC, 4);
      push(r.dx); push(r.dz);
      break;
    }
    case OP.DEPOSIT_FOOD:   Q.depositFood(world, b.x, b.z, 0.5);   break;
    case OP.DEPOSIT_DANGER:
      if (world.curriculum && !world.curriculum.danger) break;
      Q.depositDanger(world, b.x, b.z, 0.5);
      break;
    case OP.DEPOSIT_CUSTOM: Q.depositCustom(world, b.x, b.z, 0.5); break;

    case OP.MUTATE:
      b.program = VM.mutateProgram(b.program, rng, false);
      break;

    case OP.DATA_READ: {
      const idx = pop() & (VM.DATA_SIZE - 1);
      push(b.data[idx]);
      break;
    }
    case OP.DATA_WRITE: {
      const val = pop();
      const idx = pop() & (VM.DATA_SIZE - 1);
      b.data[idx] = Math.max(-128, Math.min(127, val)) | 0;
      break;
    }

    case OP.BUILD: {
      const _n = world.worldhdr[2];
      if (_n < world.STRUCT_MAX && b.energy > 15) {
        const _o = _n * 10;
        world.struct[_o + 0] = b.x;
        world.struct[_o + 1] = b.z;
        world.struct[_o + 2] = 1.0;
        world.struct[_o + 3] = b.id;
        world.struct[_o + 4] = world.simTime;
        const dBase = _n * STRUCT_DATA_SIZE;
        for (let k = 0; k < STRUCT_DATA_SIZE; k++)
          world.structData[dBase + k] = b.data[k];
        const pBase = _n * STRUCT_PROG_SIZE;
        world.structProg.set(b.program, pBase);
        world.worldhdr[2] = _n + 1;
        b.energy -= 15;
      }
      break;
    }

    case OP.SENSE_STRUCTURE_X: {
      const s = Q.nearestStructure(world, b.x, b.z, b.genes.sense);
      const dx = s ? s.x - b.x : 0;
      push(Math.max(-127, Math.min(127, Math.round(dx / 50))));
      break;
    }
    case OP.SENSE_STRUCTURE_Z: {
      const s = Q.nearestStructure(world, b.x, b.z, b.genes.sense);
      const dz = s ? s.z - b.z : 0;
      push(Math.max(-127, Math.min(127, Math.round(dz / 50))));
      break;
    }

    case OP.STRUCTURE_READ: {
      const s_idx = pop() & (VM.DATA_SIZE - 1);
      const d_idx = pop() & (VM.DATA_SIZE - 1);
      const near = Q.nearestStructure(world, b.x, b.z, world.STRUCTURE_RANGE);
      if (near) b.data[d_idx] = world.structData[near.idx * VM.DATA_SIZE + s_idx];
      break;
    }
    case OP.STRUCTURE_WRITE: {
      const val   = pop();
      const s_idx = pop() & (VM.DATA_SIZE - 1);
      const near  = Q.nearestStructure(world, b.x, b.z, world.STRUCTURE_RANGE);
      if (near) world.structData[near.idx * VM.DATA_SIZE + s_idx] =
        Math.max(-128, Math.min(127, val)) | 0;
      break;
    }
    case OP.STRUCTURE_WRITE_PROG: {
      const len  = (pop() & 63) + 1;
      const dst  = pop() & VM.LEN_MASK;
      const src  = pop() & VM.LEN_MASK;
      const near = Q.nearestStructure(world, b.x, b.z, world.STRUCTURE_RANGE);
      if (near) {
        const base = near.idx * STRUCT_PROG_SIZE;
        for (let k = 0; k < len; k++)
          world.structProg[(base + dst + k) & (STRUCT_PROG_SIZE - 1)] =
            b.program[(src + k) & VM.LEN_MASK];
        b.energy -= 0.5 + len * 0.05;
        world.ledger.addSink(0.5 + len * 0.05);
      }
      break;
    }

    case OP.STRUCTURE_CONSUME: {
      const _near = Q.nearestStructure(world, b.x, b.z, 100);
      if (_near && _near.integrity < 0.75) {
        const _o = _near.idx * 10;
        const _lost = 15 * world.struct[_o + 2];
        world.struct[_o + 2] = 0;
        world.ledger.addSink(_lost);
      }
      break;
    }

    case OP.SENSE_STATE: {
      const slot = pop() & (world.STATE_SIZE - 1);
      b.energy -= 0.18;
      world.ledger.addSink(0.18);
      push(Math.max(-127, Math.min(127, Math.round(b.state[slot] * 40))));
      b._directReads = (b._directReads || 0) + 1;
      break;
    }

    case OP.SENSE_DANGER_X: {
      if (!b._dangerCacheValid || world.simTime - b._dangerCacheTime > 0.4){
        const boost = 1 + 0.6 * Math.min(1, (b._stateMag || 0) / 8);
        b._dangerCache = Q.nearestDanger(world, b.x, b.z, b.genes.sense * boost);
        b._dangerCacheValid = true;
        b._dangerCacheTime = world.simTime;
        b.energy -= world.SENSE_COST;
        world.ledger.addSink(world.SENSE_COST);
      }
      b._dangerNoiseX = (rng() - 0.5) * 150;
      const d = b._dangerCache;
      const dx = (d ? d.x - b.x : 0) + (b._dangerNoiseX || 0);
      push(Math.max(-127, Math.min(127, Math.round(dx / 50))));
      break;
    }
    case OP.SENSE_DANGER_Z: {
      if (!b._dangerCacheValid || world.simTime - b._dangerCacheTime > 0.4){
        const boost = 1 + 0.6 * Math.min(1, (b._stateMag || 0) / 8);
        b._dangerCache = Q.nearestDanger(world, b.x, b.z, b.genes.sense * boost);
        b._dangerCacheValid = true;
        b._dangerCacheTime = world.simTime;
        b.energy -= world.SENSE_COST;
        world.ledger.addSink(world.SENSE_COST);
      }
      b._dangerNoiseZ = (rng() - 0.5) * 150;
      const d = b._dangerCache;
      const dz = (d ? d.z - b.z : 0) + (b._dangerNoiseZ || 0);
      push(Math.max(-127, Math.min(127, Math.round(dz / 50))));
      break;
    }

    case OP.SENSE_SELF: {
      const fused = b._fusedSelf ?? 0;
      push(Math.max(-80, Math.min(80, Math.round(fused * 80))));
      b._selfReadUntil = world.simTime + 5.0;
      break;
    }

    case OP.VALENCE:
      push(Math.max(-127, Math.min(127, Math.round((b._valence ?? 0) * 80))));
      break;

    case OP.CALL: {
      if (b.rsp < VM.RET_STACK_MAX){
        b.retStack[b.rsp++] = (pc + 2) & VM.LEN_MASK;
        nextPC = prog[(pc + 1) & VM.LEN_MASK] & VM.LEN_MASK;
      }
      break;
    }
    case OP.RET:
      nextPC = (b.rsp > 0) ? b.retStack[--b.rsp] & VM.LEN_MASK : 0;
      break;

    case OP.INVOKE_SYMBIONT: {
      const idx = pop() & 7;
      if (!b.symbionts || idx >= b.symbionts.length) break;
      runSymbiontInstruction(b, b.symbionts[idx], world, rng);
      break;
    }

    case OP.RELEASE_SYMBIONT: {
      const idx = pop() & 7;
      if (!b.symbionts || idx >= b.symbionts.length) break;
      const sym = b.symbionts.splice(idx, 1)[0];
      b._pendingNewborn = sym;
      break;
    }


    case OP.PREDICT_SELF:
      push(Math.max(-127, Math.min(127, Math.round((b._predictedFused ?? 0) * 80))));
      break;
    case OP.SELF_ERROR:
      push(Math.max(-127, Math.min(127, Math.round((b._predError ?? 0) * 80))));
      break;
    case OP.SELF_TRACE:
      push(Math.max(-127, Math.min(127, Math.round((b._selfTrace ?? 0) * 80))));
      break;
    case OP.SELF_VARIANCE:
      push(Math.max(-127, Math.min(127, Math.round((b._selfTraceVar ?? 0) * 1000))));
      break;

    case OP.REMEMBER: {
      if (world.curriculum && !world.curriculum.delay) break;
      const E = b._episodic;
      if (!E) break;
      const base = E.head * world.STATE_SIZE;
      for (let i = 0; i < world.STATE_SIZE; i++) E.states[base + i] = b.state[i];
      E.actions[E.head] = b._lastAction || 0;
      E.rewards[E.head] = 0;
      E.head = (E.head + 1) % VM.EPISODE_LEN;
      if (E.len < VM.EPISODE_LEN) E.len++;
      break;
    }
    case OP.RECALL: {
      if (world.curriculum && !world.curriculum.delay) { push(0); break; }
      const delay = pop();
      const E = b._episodic;
      if (!E || E.len === 0){ push(0); break; }
      const idx = ((E.head - 1 - delay) % VM.EPISODE_LEN + VM.EPISODE_LEN) % VM.EPISODE_LEN;
      const base = idx * world.STATE_SIZE;
      let fold = 0;
      for (let i = 0; i < world.STATE_SIZE; i++) fold += Math.sin(E.states[base + i] * (1.618 + i * 0.317));
      push(Math.max(-127, Math.min(127, Math.round(Math.tanh(fold * 0.35) * 80))));
      break;
    }
    case OP.REPLAY: {
      const horizon = pop();
      const steps = Math.max(1, Math.min(32, horizon));
      let predicted = b._predBias;
      for (let i = 0; i < world.STATE_SIZE; i++) predicted += b._predWeights[i] * b.state[i];
      predicted = Math.tanh(predicted * 0.5);
      predicted *= Math.exp(-steps * 0.02);
      push(Math.max(-127, Math.min(127, Math.round(predicted * 80))));
      break;
    }
    case OP.CREDIT: {
      if (world.curriculum && !world.curriculum.delay) break;
      const delay = pop();
      const E = b._episodic;
      if (!E || E.len === 0) break;
      const idx = ((E.head - 1 - delay) % VM.EPISODE_LEN + VM.EPISODE_LEN) % VM.EPISODE_LEN;
      const reward = E.rewards[idx];
      const action = E.actions[idx];
      if (!b._actionValues) b._actionValues = new Float32Array(256);
      b._actionValues[action] = b._actionValues[action] * 0.95 + reward * 0.05;
      break;
    }
    case OP.EPISODE_LEN:
      push(b._episodic ? b._episodic.len : 0);
      break;
    case OP.EPISODE_REWARD: {
      const delay = pop();
      const E = b._episodic;
      if (!E || E.len === 0){ push(0); break; }
      const idx = ((E.head - 1 - delay) % VM.EPISODE_LEN + VM.EPISODE_LEN) % VM.EPISODE_LEN;
      push(Math.max(-127, Math.min(127, Math.round(E.rewards[idx] * 10))));
      break;
    }

    case OP.PREDICT_WORLD: {
      const WM = b._worldModel;
      if (!WM){ push(0); break; }
      const next = _stateScratchA;
      for (let j = 0; j < world.STATE_SIZE; j++){
        let pred = WM.bias;
        const rowBase = j * world.STATE_SIZE;
        for (let i = 0; i < world.STATE_SIZE; i++) pred += WM.W[rowBase + i] * b.state[i];
        next[j] = Math.max(-3, Math.min(3, pred));
      }
      let fold = 0;
      for (let i = 0; i < world.STATE_SIZE; i++) fold += Math.sin(next[i] * (1.618 + i * 0.317));
      push(Math.max(-127, Math.min(127, Math.round(Math.tanh(fold * 0.35) * 80))));
      break;
    }
    case OP.WORLD_ERROR: {
      const WM = b._worldModel;
      push(Math.max(-127, Math.min(127, Math.round((WM ? WM.predictionError : 0) * 40))));
      break;
    }
    case OP.IMAGINE: {
      const horizon = pop();
      const steps = Math.max(1, Math.min(16, horizon));
      const WM = b._worldModel;
      if (!WM){ push(0); break; }
      const cur = _stateScratchA;
      cur.set(b.state);
      const next = _stateScratchB;
      for (let s = 0; s < steps; s++){
        for (let j = 0; j < world.STATE_SIZE; j++){
          let pred = WM.bias;
          const rowBase = j * world.STATE_SIZE;
          for (let i = 0; i < world.STATE_SIZE; i++) pred += WM.W[rowBase + i] * cur[i];
          next[j] = Math.max(-3, Math.min(3, pred));
        }
        cur.set(next);
      }
      let fold = 0;
      for (let i = 0; i < world.STATE_SIZE; i++) fold += Math.sin(cur[i] * (1.618 + i * 0.317));
      push(Math.max(-127, Math.min(127, Math.round(Math.tanh(fold * 0.35) * 80))));
      break;
    }
    case OP.BIND_ACTION: {
      if (b._phiDisabled){ push(0); break; }
      const wIdx = pop() & 7;
      const g = b._fusedSelf ?? 0;
      const W = b._worldModel ? b._worldModel.predictionError : 0;
      const slot = b.state[wIdx] || 0;
      const conf = 1 / (1 + W * 2);
      const bias = Math.tanh(g * slot * 0.8) * conf;
      push(Math.max(-127, Math.min(127, Math.round(bias * 80))));
      b._phiUse = (b._phiUse || 0) + 1;
      break;
    }
    case OP.SENSE_OTHER_SELF:
      push(Math.max(-80, Math.min(80, Math.round((b._otherFused ?? 0) * 80))));
      b.energy -= 0.10;
      world.ledger.addSink(0.10);
      break;
    case OP.SENSE_G2:
      push(Math.max(-80, Math.min(80, Math.round((b._g2 ?? 0) * 80))));
      b._g2Use = (b._g2Use || 0) + 1;
      break;
    case OP.BIND_SOCIAL: {
      const wIdx = pop() & 7;
      const g2 = b._g2 ?? 0;
      const W = b._worldModel ? b._worldModel.predictionError : 0;
      const slot = b.state[wIdx] || 0;
      const conf = 1 / (1 + W * 2);
      const bias = Math.tanh(g2 * slot * 0.7) * conf;
      push(Math.max(-127, Math.min(127, Math.round(bias * 80))));
      break;
    }
    case OP.BIND: {
      const j = (pop() & 7) + 24;
      const i = pop() & (world.STATE_SIZE - 1);
      const v = Math.tanh(b.state[i] * b.state[j]);
      b.state[j] = Math.max(-3, Math.min(3, v));
      break;
    }
    case OP.CALL_IND: {
      const addr = pop() & VM.LEN_MASK;
      if (b.rsp < VM.RET_STACK_MAX){
        b.retStack[b.rsp++] = (pc + 1) & VM.LEN_MASK;
        nextPC = addr;
      }
      break;
    }
    case OP.READ_PROGRAM: {
      const len  = (pop() & 63) + 1;
      const dst  = pop() & VM.LEN_MASK;
      const src  = pop() & VM.LEN_MASK;
      const near = Q.nearestStructure(world, b.x, b.z, world.STRUCTURE_RANGE);
      if (near) {
        const base = near.idx * STRUCT_PROG_SIZE;
        for (let k = 0; k < len; k++)
          b.program[(dst + k) & VM.LEN_MASK] =
            world.structProg[(base + src + k) & (STRUCT_PROG_SIZE - 1)];
        b.energy -= 0.5 + len * 0.05;
        world.ledger.addSink(0.5 + len * 0.05);
      }
      break;
    }

    case OP.SENSE_NEIGHBOR_DATA: {
      const idx = pop() & (VM.DATA_SIZE - 1);
      const near = b._neighborCache;
      if (!near || near.id === undefined){ push(0); break; }
      const other = world.getBeingById(near.id);
      push(other && other.data ? other.data[idx] : 0);
      break;
    }

    case OP.SIGNAL_NEIGHBOR: {
      if (world.curriculum && !world.curriculum.signal) { pop(); pop(); break; }
      const val = pop();
      const idx = pop() & (VM.DATA_SIZE - 1);
      const near = b._neighborCache
        ? b._neighborCache
        : Q.nearestBeing(world, b.x, b.z, b.genes.sense, b.id);
      if (!near) break;
      const other = world.getBeingById(near.id);
      if (!other || !other.data) break;
      other.data[idx] = Math.max(-128, Math.min(127, val)) | 0;
      b.energy -= 0.02;
      world.ledger.addSink(0.02);
      break;
    }

    case OP.SENSE_CORPSE_X: {
      if (!b._corpseCacheValid || world.simTime - b._corpseCacheTime > 0.4){
        b._corpseCache = Q.nearestCorpse(world, b.x, b.z, b.genes.sense);
        b._corpseCacheValid = true;
        b._corpseCacheTime = world.simTime;
        b.energy -= world.SENSE_COST;
        world.ledger.addSink(world.SENSE_COST);
      }
      const c = b._corpseCache;
      const dx = c ? c.x - b.x : 0;
      push(Math.max(-127, Math.min(127, Math.round(dx / 50))));
      break;
    }
    case OP.SENSE_CORPSE_Z: {
      if (!b._corpseCacheValid || world.simTime - b._corpseCacheTime > 0.4){
        b._corpseCache = Q.nearestCorpse(world, b.x, b.z, b.genes.sense);
        b._corpseCacheValid = true;
        b._corpseCacheTime = world.simTime;
        b.energy -= world.SENSE_COST;
        world.ledger.addSink(world.SENSE_COST);
      }
      const c = b._corpseCache;
      const dz = c ? c.z - b.z : 0;
      push(Math.max(-127, Math.min(127, Math.round(dz / 50))));
      break;
    }

    case OP.ASSIMILATE: {
  const prey = Q.nearestBeing(world, b.x, b.z, 60, b.id);
  if (!prey) break;
  const preyBeing = world.getBeingById(prey.id);
  if (!preyBeing || preyBeing.dead) break;
  if (preyBeing === b) break;

  // ── 1. Program append ──────────────────────────────────────────
  // Host's logical end, prey's logical end.
  let hostLen = BeingVM.LEN_MAX;
  while (hostLen > 4 && b.program[hostLen - 1] === 0) hostLen--;
  let preyLen = BeingVM.LEN_MAX;
  while (preyLen > 4 && preyBeing.program[preyLen - 1] === 0) preyLen--;

  const K = 256;  // bytes absorbed per merge
  const room = BeingVM.LEN_MAX - hostLen;
  const take = Math.min(K, preyLen, room);

  if (take > 0) {
    for (let i = 0; i < take; i++) {
      b.program[hostLen + i] = preyBeing.program[i];
    }
    if (hostLen + take < BeingVM.LEN_MAX) {
      b.program[hostLen + take] = OP.RET;
    }
  }
  b._lastAbsorbedAddr = hostLen;

  // ── 1b. Heritage ──────────────────────────────────────────────
  // Record the absorbed program so it can be passed on at death.
  // This is the Gu accumulation: the winner carries what it defeated.
  if (!b._heritage) b._heritage = [];
  if (b._heritage.length < 16) {
    b._heritage.push(Array.from(preyBeing.program));
  }
  b._assimilationCount = (b._assimilationCount || 0) + 1;

  // Absorbed beings make the host physically larger.
  // Growth is sublinear: doubling the count grows size by ~40%.
  const growth = Math.pow(1.40, 1 / 8);
  b.genes.size = Math.min(12.0, b.genes.size * growth);

  // ── 2. Gene blend ──────────────────────────────────────────────
  const blendGM = (a, c) => Math.max(0.05, Math.min(1e6, Math.sqrt(a * c)));
  b.genes.speed      = blendGM(b.genes.speed,      preyBeing.genes.speed);
  b.genes.sense      = blendGM(b.genes.sense,      preyBeing.genes.sense);
  b.genes.size       = blendGM(b.genes.size,       preyBeing.genes.size);
  b.genes.metabolism = blendGM(b.genes.metabolism, preyBeing.genes.metabolism);
  b.genes.lifespan   = blendGM(b.genes.lifespan,   preyBeing.genes.lifespan);
  b.genes.repCost    = blendGM(b.genes.repCost,    preyBeing.genes.repCost);
  b.genes.stateDecay     = (b.genes.stateDecay    + preyBeing.genes.stateDecay)    / 2;
  b.genes.stateCoupling  = (b.genes.stateCoupling + preyBeing.genes.stateCoupling) / 2;
  b.genes.stateInput     = (b.genes.stateInput    + preyBeing.genes.stateInput)    / 2;
  b.genes.fusionStrength = (b.genes.fusionStrength + preyBeing.genes.fusionStrength) / 2;
  b.genes.fusionDepth    = Math.max(b.genes.fusionDepth | 0, preyBeing.genes.fusionDepth | 0);
  b.genes.fusionSeed     = ((b.genes.fusionSeed + preyBeing.genes.fusionSeed) / 2) % 1;
  for (let i = 0; i < world.STATE_SIZE; i++) {
    const a = b.genes.fusionAttn[i] || 1.0;
    const c = preyBeing.genes.fusionAttn[i] || 1.0;
    b.genes.fusionAttn[i] = (a + c) * 0.5;
  }
  // Blended genome must remain viable — caller's invariant.
  b.genes.fusionEnabled = (b.genes.fusionEnabled || preyBeing.genes.fusionEnabled) ? 1 : 0;
  // Shape blend: absorbed being's anatomy folds into the host's.
  // Geometric mean per parameter. A spindly being eating a bulbous
  // being produces a mid-bodied composite.
  if (!b.genes.shapeParams) b.genes.shapeParams = new Float32Array(16);
  if (preyBeing.genes.shapeParams) {
    for (let i = 0; i < 16; i++) {
      b.genes.shapeParams[i] = Math.max(0.01, Math.min(2.5,
        Math.sqrt(b.genes.shapeParams[i] * preyBeing.genes.shapeParams[i])
      ));
    }
  }

  // Each absorbed guest raises the ceiling on this being's own
  // potential. This is the GU accumulation: eating a richer being
  // raises your own capacity. Diminishing returns beyond ~4.
  const aCount = b._assimilationCount || 0;
  const ceilScale = Math.pow(1.06, Math.min(aCount, 8));
  b.genes.sense      = Math.min(1e6, b.genes.sense      * ceilScale);
  b.genes.lifespan   = Math.min(1e6, b.genes.lifespan   * ceilScale);
  b.genes.repCost    = Math.max(0.05, b.genes.repCost   / ceilScale);

  // ── 3. Data merge ──────────────────────────────────────────────
  for (let i = 0; i < BeingVM.DATA_SIZE; i++) {
    let v = b.data[i] + preyBeing.data[i];
    if (v > 127) v -= 256;
    if (v < -128) v += 256;
    b.data[i] = v;
  }

  // ── 4. State mix ───────────────────────────────────────────────
  for (let i = 0; i < world.STATE_SIZE; i++) {
    b.state[i] = (b.state[i] + preyBeing.state[i]) * 0.5;
  }
  // Reset effective parameters to the blended genes. The host's
  // within-lifetime development is discarded: the new genome is a
  // new starting point, and development resumes from there.
  b._effDecay    = b.genes.stateDecay;
  b._effCoupling = b.genes.stateCoupling;
  b._effInput    = b.genes.stateInput;

  // ── 5. Energy transfer, retire prey ────────────────────────────
  const kept = preyBeing.energy * 0.6;
  b.energy += kept;
  world.ledger.addSink(preyBeing.energy - kept);
  b.energy -= 0.3;
  world.ledger.addSink(0.3);
  preyBeing.dead = true;
  Q.depositDanger(world, preyBeing.x, preyBeing.z, 0.8);
  break;
}

    case OP.ENGULF: {
      const dz = pop();
      const dx = pop();
      const maxSym = b._maxSymbionts ?? 8;
      const symCount = (b.symbionts && b.symbionts.length) | 0;
      if (symCount >= maxSym) break;
      const target = Q.nearestBeingInDirection(world, b, dx, dz, 60);
      if (!target || target.id === b.id) break;
      const targetBeing = world.getBeingById(target.id);
      if (!targetBeing || targetBeing.dead) break;
      if (targetBeing._boundTo !== undefined) break;

      // ── Goal alignment test ────────────────────────────────
      // If the two beings' fused selves are close in value AND
      // their energies are within 40%, this is a cooperative
      // fusion: both survive, both programs run on host body.
      // Otherwise it is predation: host wins, target dies.
      const align = Math.abs((b._g2 ?? 0) - (targetBeing._g2 ?? 0));
      const eMax  = Math.max(b.energy, targetBeing.energy) || 1;
      const eDiff = Math.abs(b.energy - targetBeing.energy) / eMax;

      if (align < 0.35 && eDiff < 0.4) {
        // ── Cooperative fusion ──────────────────────────────
        if (!b.symbionts) b.symbionts = [];
        b.symbionts.push({
          being:    targetBeing,       // live reference
          id:       targetBeing.id,
          born:     world.simTime,
          // legacy mirrors so anything that reads these still works:
          program:  targetBeing.program,
          data:     targetBeing.data,
          state:    targetBeing.state,
          stack:    targetBeing.stack,
          retStack: targetBeing.retStack,
          pc: 0, sp: 0, rsp: 0,
          genes:    targetBeing.genes,
        });
        targetBeing._boundTo = b.id;
        b._mergeCount = (b._mergeCount || 0) + 1;
        // Both stay alive. No energy transfer — the fusion is
        // additive, not extractive.
        break;
      }

      // ── Predation ──────────────────────────────────────────
      if (targetBeing.energy >= b.energy * 0.9) break;
      if (targetBeing.symbionts && targetBeing.symbionts.length > 0) break;
      if (!b.symbionts) b.symbionts = [];
      b.symbionts.push({
        id: targetBeing.id,
        program: targetBeing.program.slice(),
        data:    targetBeing.data.slice(),
        state:   new Float32Array(targetBeing.state),
        pc: 0, sp: 0, rsp: 0,
        stack:    new Int16Array(VM.STACK_MAX),
        retStack: new Int16Array(VM.RET_STACK_MAX),
        born: world.simTime,
        genes: { ...targetBeing.genes },
      });
      const absorbed = targetBeing.energy * 0.6;
      b.energy += absorbed;
      world.ledger.addSink(targetBeing.energy * 0.4);
      targetBeing.dead = true;
      b._mergeCount = (b._mergeCount || 0) + 1;
      Q.depositDanger(world, targetBeing.x, targetBeing.z, 0.8);
      break;
    }

    default:
      b.pc = 0;
      b.sp = 0;
      return false;
  }

  b.pc = nextPC;
  b.sp = sp;
  return true;
}

export function runSymbiontInstruction(host, sym, world, rng){
  const VM = BeingVM;
  const OP = VM.OP;
  // Prefer a live-bound guest's own state; fall back to the copied
  // program-data that predation creates.
  const b   = sym.being ?? sym;
  const prog = b.program;
  const stack = b.stack;
  let pc = b.pc;
  let sp = b.sp;
  if (pc < 0 || pc >= VM.LEN_MAX){ sym.pc = 0; return; }
  const op = prog[pc];
  let nextPC = pc + 1;
  const push = (v) => { if (sp < VM.STACK_MAX) stack[sp++] = v | 0; };
  const pop  = () => (sp > 0 ? stack[--sp] : 0);

  switch (op){
    case OP.NOP: break;
    case OP.PUSH: {
      let v = prog[(pc + 1) & VM.LEN_MASK];
      if (v > 127) v -= 256;
      push(v); nextPC = pc + 2; break;
    }
    case OP.DROP: pop(); break;
    case OP.DUP: {
      if (sp > 0 && sp < VM.STACK_MAX) stack[sp++] = stack[sp - 1];
      break;
    }
    case OP.ADD: { const x = pop(), y = pop(); push(y + x); break; }
    case OP.SUB: { const x = pop(), y = pop(); push(y - x); break; }
    case OP.LT:  { const x = pop(), y = pop(); push(y < x ? 1 : 0); break; }
    case OP.JMP: nextPC = prog[(pc + 1) & VM.LEN_MASK] & VM.LEN_MASK; break;
    case OP.JZ: {
      const v = pop();
      nextPC = (v === 0) ? prog[(pc + 1) & VM.LEN_MASK] & VM.LEN_MASK : pc + 2;
      break;
    }
    case OP.DATA_READ: {
      const idx = pop() & (VM.DATA_SIZE - 1);
      push(sym.data[idx]); break;
    }
    case OP.DATA_WRITE: {
      const val = pop();
      const idx = pop() & (VM.DATA_SIZE - 1);
      sym.data[idx] = Math.max(-128, Math.min(127, val)) | 0;
      break;
    }
    case OP.SENSE_STATE: {
      const slot = pop() & (world.STATE_SIZE - 1);
      push(Math.max(-127, Math.min(127, Math.round(host.state[slot] * 40))));
      break;
    }
    case OP.SENSE_SELF:
      push(Math.max(-80, Math.min(80, Math.round((host._fusedSelf ?? 0) * 80))));
      break;
    case OP.VALENCE:
      push(Math.max(-127, Math.min(127, Math.round((host._valence ?? 0) * 80))));
      break;
    case OP.SELF_TRACE:
      push(Math.max(-127, Math.min(127, Math.round((host._selfTrace ?? 0) * 80))));
      break;
    case OP.SELF_ERROR:
      push(Math.max(-127, Math.min(127, Math.round((host._predError ?? 0) * 80))));
      break;
    case OP.CALL: {
      if (sym.rsp < VM.RET_STACK_MAX){
        sym.retStack[sym.rsp++] = (pc + 2) & VM.LEN_MASK;
        nextPC = prog[(pc + 1) & VM.LEN_MASK] & VM.LEN_MASK;
      }
      break;
    }
    case OP.RET:
      nextPC = (sym.rsp > 0) ? sym.retStack[--sym.rsp] & VM.LEN_MASK : 0;
      break;
    case OP.CALL_IND: {
      const addr = pop() & VM.LEN_MASK;
      if (sym.rsp < VM.RET_STACK_MAX){
        sym.retStack[sym.rsp++] = (pc + 1) & VM.LEN_MASK;
        nextPC = addr;
      }
      break;
    }
    case OP.BIND: {
      const j = (pop() & 7) + 24;
      const i = pop() & (world.STATE_SIZE - 1);
      const v = Math.tanh(host.state[i] * host.state[j]);
      host.state[j] = Math.max(-3, Math.min(3, v));
      break;
    }

    case OP.FORM: {
      const comp = pop() & 1;
      const slot = pop() & (world.STATE_SIZE - 1);
      if (host.form) {
        host.form[comp] = Math.max(-2, Math.min(2, Math.tanh(host.state[slot])));
      }
      break;
    }

    default: break;
  }
  b.pc = nextPC;
  b.sp = sp;
  if (sym.being) {
    sym.being.pc = nextPC;
    sym.being.sp = sp;
  }
}