/**
 * Global simulation constants. Units are SI (m, kg, s, N) unless noted.
 */

export const SIM_HZ = 100;
export const SIM_DT = 1 / SIM_HZ;

export const G = 9.81;

// ---- Line ----------------------------------------------------------------

export const STATION_COUNT = 20;
export const TRAIN_COUNT = 12;
export const TRAINS_PER_TRACK = TRAIN_COUNT / 2;

/** Blocks shorter than this are merged during generation. */
export const BLOCK_MIN_LENGTH = 280;
export const BLOCK_TARGET_LENGTH = 460;
export const BLOCK_SPREAD = 70;

// ---- Train ---------------------------------------------------------------

export const CAR_COUNT = 6;
export const CAR_LENGTH = 19.8;
export const TRAIN_LENGTH = CAR_COUNT * CAR_LENGTH; // 118.8 m

export const EMPTY_MASS = 204_000; // kg, AW0
export const FULL_LOAD_MASS = 126_000; // kg additional at AW3 (crush load)
export const ROTATIONAL_FACTOR = 1.06; // inertia of rotating parts

export const MAX_SPEED = 80 / 3.6; // 80 km/h
export const ROLLBACK_SPEED = 5 / 3.6; // permitted reversing speed, 5 km/h

// Traction: constant-force region up to switch speed, then constant power.
export const MAX_TRACTIVE_FORCE = 230_000; // N at standstill, notch 4
export const MAX_TRACTIVE_POWER = 2_600_000; // W
export const POWER_NOTCHES = 4;
export const TRACTION_BUILD_TAU = 0.6; // s
export const TRACTION_RELEASE_TAU = 1.0;

// Braking
export const BRAKE_NOTCHES = 7;
export const SERVICE_MAX_DECEL = 1.1; // m/s^2 at notch 7
export const EB_DECEL = 1.3; // emergency brake guaranteed target
export const ED_FULL_SPEED = 3.0; // electric brake fully available above this
export const ED_FADEOUT_SPEED = 0.6; // electric brake fully gone below this
export const ED_MAX_FORCE = 265_000; // N
export const AIR_MAX_FORCE = 220_000; // N
/** Total brake-force hardware capacity; a brake notch requests a fraction of this fixed force. */
export const BRAKE_TOTAL_FORCE = ED_MAX_FORCE + AIR_MAX_FORCE;
/** Emergency application exceeds the full service notch. */
export const EB_FORCE = Math.round(BRAKE_TOTAL_FORCE * 1.15);
export const ED_TAU = 0.35; // electric brake response
export const AIR_FILL_TAU = 1.4; // air brake build-up
export const AIR_RELEASE_TAU = 2.2;
export const STANDSTILL_SPEED = 0.3; // |v| below this counts as stopped
/** A train must stay under STANDSTILL_SPEED for this long before "stopped" is registered. */
export const STOP_CONFIRM_TIME = 0.5;
export const EB_STOPPED_HOLD = 1.0; // s stopped before EB may be released;

// Running resistance (Davis): R = A + B*v + C*v^2, whole train
export const DAVIS_A = 2800;
export const DAVIS_B = 28;
export const DAVIS_C = 7.2;
/** Chinese railway curve resistance w = 700/R (N per kN) -> a = g*700/R. */
export const CURVE_RESIST_COEFF = 700;

// ---- ATP / signalling ----------------------------------------------------

/**
 * Guaranteed emergency decel used for supervision curves. Deliberately below
 * the physical EB_DECEL so the guarantee holds even on adverse gradients.
 */
export const ATP_GUARANTEE_DECEL = 1.0;
/** Warning curve is computed with a higher decel, so it sits above the guarantee curve. */
export const ATP_WARN_FACTOR = 1.25;
export const ATP_LOOK_AHEAD = 2500; // m
export const SAFETY_MARGIN = 50; // m behind an occupied block / buffer
export const LINE_END_MARGIN = 30;

// ---- Station operations --------------------------------------------------

export const STOP_TOLERANCE = 0.3; // +/-30 cm opens the platform screen doors
export const ROLLBACK_MAX_DISTANCE = 15; // overshoot beyond this is a failed stop
export const DWELL_TIME = 30; // s doors-open time
export const MIN_DOORS_OPEN_TIME = 10; // player cannot close doors earlier
export const TURNBACK_TIME = 8;

// ---- Initial fleet --------------------------------------------------------

export const FLEET_SPACING_STATIONS = 3; // trains every 3 stations per track
